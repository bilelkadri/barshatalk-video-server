// videoserver.js - Updated with working CORS fix for Vercel frontend
const express = require("express");
const cors = require("cors");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const Redis = require("ioredis");
const winston = require("winston");

const VERCEL_FRONTEND_URL = process.env.FRONTEND_URL || "https://barshatalk-frontend.vercel.app";
const REDIS_URL = process.env.REDIS_URL;
const TURN_URL = process.env.TURN_URL;
const TURN_USERNAME = process.env.TURN_USERNAME;
const TURN_PASSWORD = process.env.TURN_PASSWORD;
const PORT = process.env.PORT || 3001;

// --- Logger --- 
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

// --- CORS Middleware ---
app.use(cors({
  origin: VERCEL_FRONTEND_URL,
  credentials: true
}));

app.use(express.static("public"));

let redisClient;
if (REDIS_URL) {
  try {
    redisClient = new Redis(REDIS_URL);
    redisClient.on("connect", () => logger.info("Connected to Redis"));
    redisClient.on("error", (err) => logger.error("Redis Client Error", err));
  } catch (error) {
    logger.error("Failed to connect to Redis:", error);
    redisClient = null;
  }
} else {
  logger.warn("REDIS_URL not defined. Video chat state will not be persistent or scalable.");
  redisClient = null;
}

const io = new Server(http, {
  cors: {
    origin: VERCEL_FRONTEND_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const VIDEO_WAITING_USERS_KEY = "videochat:waiting";
const VIDEO_PARTNERS_KEY_PREFIX = "videochat:partner:";
const VIDEO_PROFILES_KEY_PREFIX = "videochat:profile:";

app.get("/api/turn-credentials", (req, res) => {
  if (!TURN_URL || !TURN_USERNAME || !TURN_PASSWORD) {
    logger.error("TURN server environment variables not set! Serving STUN only.");
    return res.json({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  }
  const turnConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      {
        urls: TURN_URL,
        username: TURN_USERNAME,
        credential: TURN_PASSWORD,
      },
    ],
  };
  res.json(turnConfig);
});

async function pairVideoUsers(socket1, socket2) {
  if (!redisClient) return;
  try {
    const partner1Key = `${VIDEO_PARTNERS_KEY_PREFIX}${socket1.id}`;
    const partner2Key = `${VIDEO_PARTNERS_KEY_PREFIX}${socket2.id}`;
    const profile1Key = `${VIDEO_PROFILES_KEY_PREFIX}${socket1.id}`;
    const profile2Key = `${VIDEO_PROFILES_KEY_PREFIX}${socket2.id}`;

    const [profile1Data, profile2Data] = await redisClient.mget(profile1Key, profile2Key);
    const profile1 = profile1Data ? JSON.parse(profile1Data) : { nickname: "Anonymous" };
    const profile2 = profile2Data ? JSON.parse(profile2Data) : { nickname: "Anonymous" };

    await redisClient.multi()
      .set(partner1Key, socket2.id)
      .set(partner2Key, socket1.id)
      .exec();

    socket1.emit("matched", { partnerId: socket2.id, initiator: true, partnerNickname: profile2.nickname });
    socket2.emit("matched", { partnerId: socket1.id, initiator: false, partnerNickname: profile1.nickname });
    logger.info(`Paired video users: ${socket1.id} (${profile1.nickname}) <-> ${socket2.id} (${profile2.nickname})`);
  } catch (error) {
    logger.error("Error pairing video users in Redis:", { error: error.message });
  }
}

async function findVideoPartner(socket) {
  if (!redisClient) {
    socket.emit("waiting");
    return;
  }
  try {
    const partnerId = await redisClient.spop(VIDEO_WAITING_USERS_KEY);
    if (partnerId && partnerId !== socket.id) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        await pairVideoUsers(socket, partnerSocket);
      } else {
        await findVideoPartner(socket);
      }
    } else {
      await redisClient.sadd(VIDEO_WAITING_USERS_KEY, socket.id);
      socket.emit("waiting");
    }
  } catch (error) {
    logger.error("Error finding video partner in Redis:", { error: error.message });
    socket.emit("waiting");
  }
}

async function disconnectVideoUser(socket) {
  if (!redisClient) return;
  const partnerKey = `${VIDEO_PARTNERS_KEY_PREFIX}${socket.id}`;
  const profileKey = `${VIDEO_PROFILES_KEY_PREFIX}${socket.id}`;
  try {
    const partnerId = await redisClient.get(partnerKey);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      const partnerPartnerKey = `${VIDEO_PARTNERS_KEY_PREFIX}${partnerId}`;
      if (partnerSocket && partnerSocket.connected) {
        partnerSocket.emit("partnerDisconnected");
      }
      await redisClient.del(partnerKey, partnerPartnerKey);
    }
    await redisClient.srem(VIDEO_WAITING_USERS_KEY, socket.id);
  } catch (error) {
    logger.error("Error disconnecting video user in Redis:", { error: error.message });
  }
}

io.on("connection", (socket) => {
  logger.info(`Video user connected: ${socket.id}`);

  socket.on("ready", async (data) => {
    if (!data || typeof data.nickname !== "string" || !data.nickname.trim() || data.nickname.length > 50 || typeof data.gender !== "string") {
      logger.warn(`Invalid profile data from ${socket.id}`);
      return;
    }
    if (redisClient) {
      try {
        const profileKey = `${VIDEO_PROFILES_KEY_PREFIX}${socket.id}`;
        const profile = {
          nickname: data.nickname.trim(),
          gender: data.gender,
        };
        await redisClient.set(profileKey, JSON.stringify(profile));
      } catch (error) {
        logger.error(`Failed to save profile for ${socket.id}`, { error: error.message });
      }
    }
    await findVideoPartner(socket);
  });

  const relayEvent = async (eventName, payload) => {
    if (!redisClient) return;
    const partnerKey = `${VIDEO_PARTNERS_KEY_PREFIX}${socket.id}`;
    try {
      const partnerId = await redisClient.get(partnerKey);
      if (partnerId) {
        const partnerSocket = io.sockets.sockets.get(partnerId);
        if (partnerSocket && partnerSocket.connected) {
          const payloadToSend = typeof payload === "object" ? { ...payload, from: socket.id } : payload;
          partnerSocket.emit(eventName, payloadToSend);
        }
      }
    } catch (error) {
      logger.error(`Error relaying ${eventName} from ${socket.id}`, { error: error.message });
    }
  };

  socket.on("offer", (offer) => relayEvent("offer", offer));
  socket.on("answer", (answer) => relayEvent("answer", answer));
  socket.on("candidate", (candidate) => relayEvent("candidate", candidate));
  socket.on("reaction", (reactionData) => relayEvent("reaction", reactionData));

  socket.on("getPartnerInfo", async (data) => {
    if (!redisClient || !data || !data.partnerId) return;
    const profileKey = `${VIDEO_PROFILES_KEY_PREFIX}${data.partnerId}`;
    try {
      const profileData = await redisClient.get(profileKey);
      const partnerProfile = profileData ? JSON.parse(profileData) : { nickname: "Anonymous", gender: "unknown" };
      socket.emit("partnerInfo", partnerProfile);
    } catch (error) {
      logger.error(`Error retrieving partner info for ${data.partnerId}`, { error: error.message });
      socket.emit("partnerInfo", { nickname: "Anonymous", gender: "unknown" });
    }
  });

  socket.on("next", async () => {
    await disconnectVideoUser(socket);
    socket.emit("waiting");
  });

  socket.on("disconnect", async () => {
    await disconnectVideoUser(socket);
  });

  socket.on("error", (err) => {
    logger.error(`Socket error from ${socket.id}:`, { error: err.message });
  });
});

http.listen(PORT, () => {
  logger.info(`✅ Video chat server running on port ${PORT}`);
});




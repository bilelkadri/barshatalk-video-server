// videoserver.js - Updated Full Code
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const Redis = require("ioredis");
const winston = require("winston");
// Add rate-limiter if you add more complex API endpoints later
// const rateLimit = require("express-rate-limit");

// --- Configuration --- 
const VERCEL_FRONTEND_URL = process.env.FRONTEND_URL || "https://barshatalk-frontend.vercel.app"; // Use environment variable
const REDIS_URL = process.env.REDIS_URL; // Needs to be set in Render environment
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
    // Add file or other transports as needed
  ],
});

// --- Redis Client --- 
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

// --- Socket.IO Server --- 
const io = new Server(http, {
  cors: {
    origin: VERCEL_FRONTEND_URL, // Updated CORS origin (Point 3 & 7)
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(express.static("public")); // Serve static files if any

// --- Redis Keys --- 
const VIDEO_WAITING_USERS_KEY = "videochat:waiting";
const VIDEO_PARTNERS_KEY_PREFIX = "videochat:partner:";
const VIDEO_PROFILES_KEY_PREFIX = "videochat:profile:";

// --- Endpoint for TURN Credentials (Point 1) --- 
// IMPORTANT: This serves STATIC credentials from env vars. 
// For better security, use a TURN provider API to generate TEMPORARY credentials per request.
app.get("/api/turn-credentials", (req, res) => {
  if (!TURN_URL || !TURN_USERNAME || !TURN_PASSWORD) {
    logger.error("TURN server environment variables not set! Serving STUN only.");
    // Return only STUN if TURN is not configured
    return res.json({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  }
  // Return STUN + TURN config from environment variables
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

// --- Redis-based State Management Functions (Point 6) --- 

async function pairVideoUsers(socket1, socket2) {
  if (!redisClient) {
    logger.error("Cannot pair video users: Redis client not available.");
    return;
  }
  try {
    const partner1Key = `${VIDEO_PARTNERS_KEY_PREFIX}${socket1.id}`;
    const partner2Key = `${VIDEO_PARTNERS_KEY_PREFIX}${socket2.id}`;
    const profile1Key = `${VIDEO_PROFILES_KEY_PREFIX}${socket1.id}`;
    const profile2Key = `${VIDEO_PROFILES_KEY_PREFIX}${socket2.id}`;

    // Retrieve profiles from Redis
    const [profile1Data, profile2Data] = await redisClient.mget(profile1Key, profile2Key);
    const profile1 = profile1Data ? JSON.parse(profile1Data) : { nickname: "Anonymous" };
    const profile2 = profile2Data ? JSON.parse(profile2Data) : { nickname: "Anonymous" };

    // Set partner associations in Redis transaction
    await redisClient.multi()
      .set(partner1Key, socket2.id)
      .set(partner2Key, socket1.id)
      .exec();

    // Emit matched event with partner info
    socket1.emit("matched", { partnerId: socket2.id, initiator: true, partnerNickname: profile2.nickname });
    socket2.emit("matched", { partnerId: socket1.id, initiator: false, partnerNickname: profile1.nickname });
    logger.info(`Paired video users (Redis): ${socket1.id} (${profile1.nickname}) <-> ${socket2.id} (${profile2.nickname})`);

  } catch (error) {
    logger.error("Error pairing video users in Redis:", { error: error.message, socket1: socket1.id, socket2: socket2.id });
    // Handle error, maybe notify users
  }
}

async function findVideoPartner(socket) {
  if (!redisClient) {
    socket.emit("waiting");
    logger.warn(`No Redis client, user ${socket.id} set to waiting (video - in-memory simulation)`);
    return;
  }
  try {
    // Try to find a partner from the waiting set
    const partnerId = await redisClient.spop(VIDEO_WAITING_USERS_KEY);

    if (partnerId && partnerId !== socket.id) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        // Found a connected partner, pair them
        await pairVideoUsers(socket, partnerSocket);
      } else {
        // Partner disconnected while waiting, try again
        logger.warn(`Video partner ${partnerId} disconnected before pairing with ${socket.id}. Retrying.`);
        await findVideoPartner(socket); // Recursive call
      }
    } else {
      // No suitable partner found, add current user to waiting set
      await redisClient.sadd(VIDEO_WAITING_USERS_KEY, socket.id);
      socket.emit("waiting");
      logger.info(`Video user ${socket.id} added to waiting list (Redis)`);
    }
  } catch (error) {
    logger.error("Error finding video partner in Redis:", { error: error.message, socketId: socket.id });
    socket.emit("waiting"); // Fallback on error
  }
}

async function disconnectVideoUser(socket) {
  if (!redisClient) {
    logger.warn(`Cannot disconnect video user ${socket.id}: Redis client not available.`);
    return;
  }
  const partnerKey = `${VIDEO_PARTNERS_KEY_PREFIX}${socket.id}`;
  const profileKey = `${VIDEO_PROFILES_KEY_PREFIX}${socket.id}`;
  try {
    // Find partner ID from Redis
    const partnerId = await redisClient.get(partnerKey);
    if (partnerId) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      const partnerPartnerKey = `${VIDEO_PARTNERS_KEY_PREFIX}${partnerId}`;
      // Notify the remaining partner
      if (partnerSocket && partnerSocket.connected) {
        partnerSocket.emit("partnerDisconnected");
        // Don't automatically put partner back in queue, wait for their 'ready' event
        logger.info(`Notified partner ${partnerId} of disconnection from ${socket.id}`);
      }
      // Delete partner associations
      await redisClient.del(partnerKey, partnerPartnerKey);
      logger.info(`Disconnected video partner link (Redis): ${socket.id} <-> ${partnerId}`);
    }
    // Remove user from waiting set (if they were there)
    await redisClient.srem(VIDEO_WAITING_USERS_KEY, socket.id);
    
    // Optional: Delete user profile after a delay or keep it for faster reconnection?
    // For now, we keep it.
    // await redisClient.del(profileKey); 
    // logger.info(`Removed profile for disconnected user ${socket.id}`);

  } catch (error) {
    logger.error("Error disconnecting video user in Redis:", { error: error.message, socketId: socket.id });
  }
}

// --- Socket.IO Connection Logic --- 
io.on("connection", (socket) => {
  logger.info(`Video user connected: ${socket.id}`);

  // Event: User is ready with profile data
  socket.on("ready", async (data) => {
    // Basic Profile Validation (Point 2)
    if (!data || typeof data.nickname !== "string" || data.nickname.length === 0 || data.nickname.length > 50 || typeof data.gender !== "string") {
      logger.warn(`Invalid profile data received from ${socket.id}`, { profileData: data });
      // Optional: Send error back to client
      // socket.emit("system_error", "Invalid profile data provided.");
      return;
    }
    logger.info(`User ${socket.id} is ready with profile:`, { nickname: data.nickname, gender: data.gender });
    
    if (redisClient) {
      try {
        // Store profile in Redis (Point 6)
        const profileKey = `${VIDEO_PROFILES_KEY_PREFIX}${socket.id}`;
        const profile = {
          nickname: data.nickname || "Anonymous",
          gender: data.gender || "unknown",
          // Add birthday or age calculation here if needed for matching later
        };
        await redisClient.set(profileKey, JSON.stringify(profile));
        // Optional: Set an expiration time for the profile (e.g., 1 hour)
        // await redisClient.expire(profileKey, 3600); 
        logger.info(`Stored profile for ${socket.id} in Redis.`);
      } catch (error) {
        logger.error(`Failed to save profile for ${socket.id} to Redis:`, { error: error.message });
      }
    }
    // Find a partner for this ready user
    await findVideoPartner(socket);
  });

  // Generic event relay function with error handling (Point 4)
  const relayEvent = async (eventName, payload) => {
    if (!redisClient) {
      logger.error(`Cannot relay ${eventName} from ${socket.id}: Redis client not available.`);
      return;
    }
    const partnerKey = `${VIDEO_PARTNERS_KEY_PREFIX}${socket.id}`;
    try {
      const partnerId = await redisClient.get(partnerKey);
      if (partnerId) {
        const partnerSocket = io.sockets.sockets.get(partnerId);
        if (partnerSocket && partnerSocket.connected) {
          // Add sender's ID for context if needed, especially for offer/answer/candidate
          const payloadToSend = typeof payload === "object" ? { ...payload, from: socket.id } : payload;
          partnerSocket.emit(eventName, payloadToSend);
          // logger.debug(`Relayed ${eventName} from ${socket.id} to ${partnerId}`);
        } else {
          // logger.warn(`Cannot relay ${eventName}: Partner ${partnerId} not connected.`);
          // Handle case where partner disconnected unexpectedly during relay?
        }
      }
    } catch (error) {
      logger.error(`Error relaying ${eventName} from ${socket.id}:`, { error: error.message });
    }
  };

  // Relay WebRTC signaling messages
  socket.on("offer", (offer) => relayEvent("offer", offer));
  socket.on("answer", (answer) => relayEvent("answer", answer));
  socket.on("candidate", (candidate) => relayEvent("candidate", candidate));
  
  // Relay reactions
  socket.on("reaction", (reactionData) => relayEvent("reaction", reactionData));

  // Event: Get partner's info (e.g., nickname)
  socket.on("getPartnerInfo", async (data) => {
    if (!redisClient || !data || !data.partnerId) return;
    logger.info(`User ${socket.id} requested partner info for ${data.partnerId}`);
    const profileKey = `${VIDEO_PROFILES_KEY_PREFIX}${data.partnerId}`;
    try {
      const profileData = await redisClient.get(profileKey);
      if (profileData) {
        const partnerProfile = JSON.parse(profileData);
        socket.emit("partnerInfo", {
          nickname: partnerProfile.nickname,
          gender: partnerProfile.gender,
        });
        logger.info(`Sent partner info (${partnerProfile.nickname}) to ${socket.id}`);
      } else {
        socket.emit("partnerInfo", { nickname: "Anonymous", gender: "unknown" });
        logger.warn(`No profile found in Redis for ${data.partnerId}, sent default`);
      }
    } catch (error) {
      logger.error(`Error retrieving partner info for ${data.partnerId} from Redis:`, { error: error.message });
      socket.emit("partnerInfo", { nickname: "Anonymous", gender: "unknown" }); // Fallback
    }
  });

  // Event: User wants the next partner
  socket.on("next", async () => {
    logger.info(`Video user requested next: ${socket.id}`);
    await disconnectVideoUser(socket);
    // Don't automatically find partner here, client needs to send 'ready' again
    socket.emit("waiting"); // Tell the client they are now waiting
  });

  // Event: User disconnects
  socket.on("disconnect", async (reason) => {
    logger.info(`Video user disconnected: ${socket.id}`, { reason });
    await disconnectVideoUser(socket);
  });

  // General Socket Error Handling (Point 4)
  socket.on("error", (err) => {
    logger.error(`Socket Error from ${socket.id} (Video):`, { error: err.message });
  });
});

// Start Server
http.listen(PORT, () => {
  logger.info(`✅ Video chat server running on port ${PORT}`);
});



const express = require("express");
const cors = require("cors");
const app = express();
const http = require("http").createServer(app);
const { Server } = require("socket.io");
const Redis = require("ioredis");

console.log("--- BarshaTalk Video Server Starting ---");

// ========== CRITICAL CORS FIX ========== //
app.use((req, res, next) => {
  // Allowed domains
  const allowedOrigins = [
    "https://barshatalk-frontend.vercel.app",
    "https://barshatalk-frontend.vercel.app",
    "http://localhost:5500"
  ];
  
  // Check if request origin is allowed
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  
  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  
  next();
});
// ========== END CORS FIX ========== //

// --- Redis Connection ---
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
let redisClient;

if (REDIS_URL) {
  try {
    // Connect to Redis (no password needed)
    redisClient = new Redis(REDIS_URL);
    
    redisClient.on('connect', () => console.log('✅ Redis connected'));
    redisClient.on('error', (err) => console.error('Redis error:', err));
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    redisClient = null;
  }
} else {
  console.warn('REDIS_URL not defined. Using in-memory state');
  redisClient = null;
}

// --- TURN Credentials Endpoint ---
app.get("/api/turn-credentials", (req, res) => {
  try {
    // Return TURN server configuration
    res.json({
      iceServers: [
        { urls: "stun:fr-turn2.xirsys.com" },
        {
          username: process.env.TURN_USERNAME,
          credential: process.env.TURN_PASSWORD,
          urls: [
            "turn:fr-turn2.xirsys.com:80?transport=udp",
            "turn:fr-turn2.xirsys.com:3478?transport=udp",
            "turn:fr-turn2.xirsys.com:80?transport=tcp",
            "turn:fr-turn2.xirsys.com:3478?transport=tcp",
            "turns:fr-turn2.xirsys.com:443?transport=tcp",
            "turns:fr-turn2.xirsys.com:5349?transport=tcp"
          ]
        }
      ]
    });
  } catch (error) {
    console.error('Error generating TURN credentials:', error);
    // Fallback to public STUN server
    res.json({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  }
});

// --- Middleware ---
app.use(cors({
  origin: process.env.FRONTEND_URL || "https://barshatalk-frontend.vercel.app",
  credentials: true
}));

app.use(express.static("public"));

// --- Redis Keys ---
const VIDEO_WAITING_USERS_KEY = "videochat:waiting";
const VIDEO_PARTNERS_KEY_PREFIX = "videochat:partner:";
const VIDEO_PROFILES_KEY_PREFIX = "videochat:profile:";

// --- User Pairing Functions ---
async function pairVideoUsers(socket1, socket2) {
  if (!redisClient) return;
  
  try {
    const partner1Key = `${VIDEO_PARTNERS_KEY_PREFIX}${socket1.id}`;
    const partner2Key = `${VIDEO_PARTNERS_KEY_PREFIX}${socket2.id}`;
    
    // Get user profiles
    const profile1 = await redisClient.get(`${VIDEO_PROFILES_KEY_PREFIX}${socket1.id}`) || '{}';
    const profile2 = await redisClient.get(`${VIDEO_PROFILES_KEY_PREFIX}${socket2.id}`) || '{}';
    
    // Save partnership in Redis
    await redisClient.multi()
      .set(partner1Key, socket2.id)
      .set(partner2Key, socket1.id)
      .exec();
    
    // Notify both users
    socket1.emit("matched", { 
      partnerId: socket2.id, 
      initiator: true,
      partnerNickname: JSON.parse(profile2).nickname || "Stranger"
    });
    
    socket2.emit("matched", { 
      partnerId: socket1.id, 
      initiator: false,
      partnerNickname: JSON.parse(profile1).nickname || "Stranger"
    });
    
    console.log(`Paired video users: ${socket1.id} <-> ${socket2.id}`);
  } catch (error) {
    console.error('Error pairing video users:', error);
  }
}

async function findVideoPartner(socket) {
  if (!redisClient) {
    socket.emit("waiting");
    return;
  }
  
  try {
    // Find a waiting partner
    const partnerId = await redisClient.spop(VIDEO_WAITING_USERS_KEY);
    
    if (partnerId && partnerId !== socket.id) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        await pairVideoUsers(socket, partnerSocket);
      } else {
        // Retry if partner disconnected
        await findVideoPartner(socket);
      }
    } else {
      // Add to waiting list if no partner found
      await redisClient.sadd(VIDEO_WAITING_USERS_KEY, socket.id);
      socket.emit("waiting");
    }
  } catch (error) {
    console.error('Error finding video partner:', error);
    socket.emit("waiting");
  }
}

async function disconnectVideoUser(socket) {
  if (!redisClient) return;
  
  try {
    const partnerKey = `${VIDEO_PARTNERS_KEY_PREFIX}${socket.id}`;
    const partnerId = await redisClient.get(partnerKey);
    
    if (partnerId) {
      // Notify partner about disconnection
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket) {
        partnerSocket.emit("partnerDisconnected");
      }
      
      // Cleanup Redis entries
      await redisClient.del(partnerKey);
      await redisClient.del(`${VIDEO_PARTNERS_KEY_PREFIX}${partnerId}`);
    }
    
    // Remove from waiting list
    await redisClient.srem(VIDEO_WAITING_USERS_KEY, socket.id);
  } catch (error) {
    console.error('Error disconnecting video user:', error);
  }
}

// --- Socket.IO Server ---
const io = new Server(http, {
  cors: {
    origin: process.env.FRONTEND_URL || "https://barshatalk-frontend.vercel.app",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// --- Socket.IO Event Handlers ---
io.on("connection", (socket) => {
  console.log(`Video user connected: ${socket.id}`);

  // User is ready to chat
  socket.on("ready", async (data) => {
    // Save user profile
    if (redisClient && data && data.nickname) {
      try {
        await redisClient.set(
          `${VIDEO_PROFILES_KEY_PREFIX}${socket.id}`,
          JSON.stringify({
            nickname: data.nickname,
            gender: data.gender || ""
          })
        );
      } catch (error) {
        console.error('Error saving profile:', error);
      }
    }
    
    // Find a chat partner
    await findVideoPartner(socket);
  });

  // WebRTC signaling events
  socket.on("offer", (data) => {
    if (!data.to || !data.offer) return;
    io.to(data.to).emit("offer", { ...data, from: socket.id });
  });

  socket.on("answer", (data) => {
    if (!data.to || !data.answer) return;
    io.to(data.to).emit("answer", { ...data, from: socket.id });
  });

  socket.on("candidate", (data) => {
    if (!data.to || !data.candidate) return;
    io.to(data.to).emit("candidate", { ...data, from: socket.id });
  });

  // User reactions (hearts)
  socket.on("reaction", (data) => {
    if (!data.to) return;
    io.to(data.to).emit("reaction", { ...data, from: socket.id });
  });

  // Request new partner
  socket.on("next", async () => {
    await disconnectVideoUser(socket);
    socket.emit("waiting");
  });

  // Cleanup on disconnect
  socket.on("disconnect", async () => {
    await disconnectVideoUser(socket);
  });
});

// --- Start Server ---
const PORT = process.env.PORT || 3001;
http.listen(PORT, () => {
  console.log(`✅ Video chat server running on port ${PORT}`);
  console.log(`✅ CORS enabled for: https://barshatalk-frontend.vercel.app`);
});

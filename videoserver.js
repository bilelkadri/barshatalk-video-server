// ✅ Updated videoserver.js with nickname support
const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http, {
  cors: {
    origin: "https://clean-horse-blinker.glitch.me",
    methods: ["GET", "POST"],
    credentials: true
  }
});

app.use(express.static("public"));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://clean-horse-blinker.glitch.me");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Credentials", "true");
  next();
});

const videoWaitingUsers = new Set();
const videoPartners = new Map();
// New: Store user profiles (nickname, gender, etc.)
const userProfiles = new Map();

function pairVideoUsers(socket1, socket2) {
  console.log(`Pairing users: ${socket1.id} and ${socket2.id}`);

  videoPartners.set(socket1.id, socket2.id);
  videoPartners.set(socket2.id, socket1.id);

  // Get user profiles if available
  const profile1 = userProfiles.get(socket1.id) || {};
  const profile2 = userProfiles.get(socket2.id) || {};

  // socket1 is the initiator - include partner nickname
  socket1.emit("matched", { 
    partnerId: socket2.id, 
    initiator: true,
    partnerNickname: profile2.nickname || "Anonymous"
  });
  
  // socket2 is not the initiator - include partner nickname
  socket2.emit("matched", { 
    partnerId: socket1.id, 
    initiator: false,
    partnerNickname: profile1.nickname || "Anonymous"
  });
  
  console.log(`Sent nicknames: ${profile1.nickname} to ${socket2.id} and ${profile2.nickname} to ${socket1.id}`);
}

function findVideoPartner(socket) {
  console.log(`Finding partner for: ${socket.id}, waiting users: ${videoWaitingUsers.size}`);

  if (videoWaitingUsers.size > 0) {
    const partnerId = [...videoWaitingUsers][0];
    const partner = io.sockets.sockets.get(partnerId);

    if (partner && partner.connected && partner.id !== socket.id) {
      videoWaitingUsers.delete(partnerId);
      pairVideoUsers(socket, partner);
    } else {
      videoWaitingUsers.delete(partnerId);
      videoWaitingUsers.add(socket.id);
      socket.emit("waiting");
    }
  } else {
    videoWaitingUsers.add(socket.id);
    socket.emit("waiting");
  }
}

function disconnectVideoUser(socket) {
  console.log(`Disconnecting user: ${socket.id}`);

  const partnerId = videoPartners.get(socket.id);
  if (partnerId) {
    const partner = io.sockets.sockets.get(partnerId);
    if (partner && partner.connected) {
      partner.emit("partnerDisconnected");
      videoPartners.delete(partner.id);
    }
  }

  videoPartners.delete(socket.id);
  videoWaitingUsers.delete(socket.id);
  // Don't delete user profile on disconnect to maintain it for reconnection
}

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Updated to receive and store user profile data
  socket.on("ready", (data) => {
    console.log(`User ${socket.id} is ready for matching with profile:`, data);
    
    // Store user profile data
    if (data) {
      userProfiles.set(socket.id, {
        nickname: data.nickname || "Anonymous",
        gender: data.gender || "unknown"
      });
      console.log(`Stored profile for ${socket.id}: ${data.nickname}`);
    }
    
    findVideoPartner(socket);
  });

  socket.on("offer", (offer) => {
    const partnerId = videoPartners.get(socket.id);
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) {
      partner.emit("offer", offer);
    }
  });

  socket.on("answer", (answer) => {
    const partnerId = videoPartners.get(socket.id);
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) {
      partner.emit("answer", answer);
    }
  });

  socket.on("candidate", (candidate) => {
    const partnerId = videoPartners.get(socket.id);
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) {
      partner.emit("candidate", candidate);
    }
  });

  // New: Handle getPartnerInfo requests
  socket.on("getPartnerInfo", (data) => {
    console.log(`User ${socket.id} requested partner info for ${data.partnerId}`);
    
    if (data && data.partnerId) {
      const partnerProfile = userProfiles.get(data.partnerId);
      if (partnerProfile) {
        socket.emit("partnerInfo", {
          nickname: partnerProfile.nickname,
          gender: partnerProfile.gender
        });
        console.log(`Sent partner info to ${socket.id}: ${partnerProfile.nickname}`);
      } else {
        socket.emit("partnerInfo", { nickname: "Anonymous", gender: "unknown" });
        console.log(`No profile found for ${data.partnerId}, sent default`);
      }
    }
  });

  // New: Handle reaction events
  socket.on("reaction", (data) => {
    if (data && data.to) {
      const partner = io.sockets.sockets.get(data.to);
      if (partner) {
        partner.emit("reaction", {
          emoji: data.emoji,
          from: socket.id,
          nickname: userProfiles.get(socket.id)?.nickname || "Anonymous"
        });
      }
    }
  });

  socket.on("next", () => {
    disconnectVideoUser(socket);
    findVideoPartner(socket);
  });

  socket.on("disconnect", () => {
    disconnectVideoUser(socket);
    // Keep user profile in memory for potential reconnection
    // Consider adding a cleanup mechanism for profiles after some time
  });
});

http.listen(process.env.PORT || 3001, () => {
  console.log("✅ Video chat server running on port 3001");
});

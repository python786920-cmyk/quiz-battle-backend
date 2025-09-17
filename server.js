// server.js - Quiz Battle Backend
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// In-memory storage (production me Redis use karenge)
const matchmakingQueue = [];
const activeRooms = new Map();
const playerSockets = new Map();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Quiz Battle Server Running!', timestamp: new Date().toISOString() });
});

// Question generator
function generateQuestion() {
  const num1 = Math.floor(Math.random() * 89) + 10; // 10-98
  const num2 = Math.floor(Math.random() * 89) + 10; // 10-98
  const correct = num1 + num2;
  
  // Generate 3 wrong options
  const wrongOptions = [];
  while (wrongOptions.length < 3) {
    let wrong = correct + Math.floor(Math.random() * 21) - 10; // ±10 range
    if (wrong !== correct && !wrongOptions.includes(wrong) && wrong > 0) {
      wrongOptions.push(wrong);
    }
  }
  
  const options = [correct, ...wrongOptions];
  
  // Shuffle options
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  
  return {
    q: `${num1} + ${num2}`,
    options: options,
    correctAnswer: correct,
    correctIndex: options.indexOf(correct)
  };
}

// Room manager
class GameRoom {
  constructor(roomId, player1, player2) {
    this.roomId = roomId;
    this.players = [
      { 
        id: player1.id, 
        username: player1.username, 
        score: 0, 
        questionsAnswered: 0,
        currentQuestion: null,
        socket: player1.socket 
      },
      { 
        id: player2.id, 
        username: player2.username, 
        score: 0, 
        questionsAnswered: 0,
        currentQuestion: null,
        socket: player2.socket 
      }
    ];
    this.gameStarted = false;
    this.gameEnded = false;
    this.startTime = null;
    this.duration = 120; // 2 minutes
  }
  
  startGame() {
    this.gameStarted = true;
    this.gameEnded = false;
    this.startTime = Date.now();
    
    // Send first question to both players
    this.players.forEach(player => {
      player.currentQuestion = generateQuestion();
      player.socket.emit('newQuestion', {
        question: {
          q: player.currentQuestion.q,
          options: player.currentQuestion.options
        },
        questionNumber: player.questionsAnswered + 1
      });
    });
    
    // Start game timer
    setTimeout(() => {
      this.endGame();
    }, this.duration * 1000);
  }
  
  submitAnswer(playerId, selectedIndex) {
    if (this.gameEnded) return;
    
    const player = this.players.find(p => p.id === playerId);
    if (!player || !player.currentQuestion) return;
    
    const isCorrect = selectedIndex === player.currentQuestion.correctIndex;
    if (isCorrect) {
      player.score += 10;
    }
    
    player.questionsAnswered++;
    
    // Send result to player
    player.socket.emit('answerResult', {
      correct: isCorrect,
      correctAnswer: player.currentQuestion.correctAnswer,
      score: player.score
    });
    
    // Broadcast score update to both players
    this.broadcastScores();
    
    // Send next question to this player only
    setTimeout(() => {
      if (!this.gameEnded) {
        player.currentQuestion = generateQuestion();
        player.socket.emit('newQuestion', {
          question: {
            q: player.currentQuestion.q,
            options: player.currentQuestion.options
          },
          questionNumber: player.questionsAnswered + 1
        });
      }
    }, 1500); // 1.5s delay for showing result
  }
  
  broadcastScores() {
    const scores = {
      player1: {
        username: this.players[0].username,
        score: this.players[0].score,
        questionsAnswered: this.players[0].questionsAnswered
      },
      player2: {
        username: this.players[1].username,
        score: this.players[1].score,
        questionsAnswered: this.players[1].questionsAnswered
      }
    };
    
    this.players.forEach(player => {
      player.socket.emit('scoreUpdate', scores);
    });
  }
  
  endGame() {
    if (this.gameEnded) return;
    
    this.gameEnded = true;
    
    const winner = this.players[0].score > this.players[1].score ? this.players[0] : 
                   this.players[1].score > this.players[0].score ? this.players[1] : null;
    
    const gameResult = {
      winner: winner ? winner.username : 'Draw',
      finalScores: {
        player1: {
          username: this.players[0].username,
          score: this.players[0].score,
          questionsAnswered: this.players[0].questionsAnswered
        },
        player2: {
          username: this.players[1].username,
          score: this.players[1].score,
          questionsAnswered: this.players[1].questionsAnswered
        }
      }
    };
    
    this.players.forEach(player => {
      player.socket.emit('gameOver', gameResult);
    });
    
    // Clean up room
    setTimeout(() => {
      activeRooms.delete(this.roomId);
    }, 10000); // Keep room for 10s for result viewing
  }
  
  handlePlayerDisconnect(playerId) {
    const disconnectedPlayer = this.players.find(p => p.id === playerId);
    const remainingPlayer = this.players.find(p => p.id !== playerId);
    
    if (remainingPlayer) {
      remainingPlayer.socket.emit('opponentDisconnected');
      // Auto-win for remaining player
      if (!this.gameEnded) {
        this.endGame();
      }
    }
    
    activeRooms.delete(this.roomId);
  }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  
  // Join matchmaking queue
  socket.on('joinQueue', (data) => {
    const player = {
      id: socket.id,
      username: data.username || `Player${Math.floor(Math.random() * 1000)}`,
      socket: socket
    };
    
    playerSockets.set(socket.id, player);
    
    // Check if there's already a player waiting
    if (matchmakingQueue.length > 0) {
      const opponent = matchmakingQueue.shift();
      
      // Create room
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const gameRoom = new GameRoom(roomId, opponent, player);
      activeRooms.set(roomId, gameRoom);
      
      // Join both players to room
      opponent.socket.join(roomId);
      player.socket.join(roomId);
      
      // Notify match found
      const matchData = {
        roomId: roomId,
        opponent: {
          username: opponent.username
        },
        you: {
          username: player.username
        }
      };
      
      opponent.socket.emit('matchFound', {
        ...matchData,
        opponent: { username: player.username }
      });
      
      player.socket.emit('matchFound', {
        ...matchData,
        opponent: { username: opponent.username }
      });
      
      // Start game after 5 seconds
      setTimeout(() => {
        gameRoom.startGame();
        io.to(roomId).emit('gameStart');
      }, 5000);
      
    } else {
      // Add to queue
      matchmakingQueue.push(player);
      socket.emit('queueJoined', { position: matchmakingQueue.length });
    }
  });
  
  // Submit answer
  socket.on('submitAnswer', (data) => {
    const room = Array.from(activeRooms.values()).find(r => 
      r.players.some(p => p.id === socket.id)
    );
    
    if (room) {
      room.submitAnswer(socket.id, data.selectedIndex);
    }
  });
  
  // WebRTC signaling for voice chat
  socket.on('webrtcOffer', (data) => {
    socket.to(data.roomId).emit('webrtcOffer', {
      offer: data.offer,
      from: socket.id
    });
  });
  
  socket.on('webrtcAnswer', (data) => {
    socket.to(data.roomId).emit('webrtcAnswer', {
      answer: data.answer,
      from: socket.id
    });
  });
  
  socket.on('webrtcCandidate', (data) => {
    socket.to(data.roomId).emit('webrtcCandidate', {
      candidate: data.candidate,
      from: socket.id
    });
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    
    // Remove from queue if waiting
    const queueIndex = matchmakingQueue.findIndex(p => p.id === socket.id);
    if (queueIndex !== -1) {
      matchmakingQueue.splice(queueIndex, 1);
    }
    
    // Handle room disconnection
    const room = Array.from(activeRooms.values()).find(r => 
      r.players.some(p => p.id === socket.id)
    );
    
    if (room) {
      room.handlePlayerDisconnect(socket.id);
    }
    
    playerSockets.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Quiz Battle Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
  });
});

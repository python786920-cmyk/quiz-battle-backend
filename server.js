const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// CORS setup for your frontend
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Database configuration
const dbConfig = {
  host: 'cashearnersofficial.xyz',
  user: 'cztldhwx_Auto_PostTg',
  password: 'Aptap786920',
  database: 'cztldhwx_Auto_PostTg',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

let dbPool;

// Initialize database pool
async function initDatabase() {
  try {
    dbPool = mysql.createPool(dbConfig);
    
    // Create tables if they don't exist
    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        games_played INT DEFAULT 0,
        games_won INT DEFAULT 0,
        total_score INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await dbPool.execute(`
      CREATE TABLE IF NOT EXISTS matches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        player1_id INT,
        player2_id INT,
        player1_score INT DEFAULT 0,
        player2_score INT DEFAULT 0,
        winner_id INT,
        match_duration INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (player1_id) REFERENCES users(id),
        FOREIGN KEY (player2_id) REFERENCES users(id),
        FOREIGN KEY (winner_id) REFERENCES users(id)
      )
    `);

    console.log('✅ Database connected and tables created');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
  }
}

// Game state management
const gameRooms = new Map();
const waitingQueue = [];
const playerSockets = new Map();

// JWT secret (use environment variable in production)
const JWT_SECRET = process.env.JWT_SECRET || 'mathbattle_secret_2025';

// Utility functions
function generateQuestion() {
  const num1 = Math.floor(Math.random() * 89) + 10; // 10-98
  const num2 = Math.floor(Math.random() * 89) + 10; // 10-98
  const correctAnswer = num1 + num2;
  
  const options = [correctAnswer];
  
  // Generate 3 wrong options
  while (options.length < 4) {
    const wrongAnswer = correctAnswer + Math.floor(Math.random() * 20) - 10;
    if (wrongAnswer > 0 && wrongAnswer !== correctAnswer && !options.includes(wrongAnswer)) {
      options.push(wrongAnswer);
    }
  }
  
  // Shuffle options
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  
  return {
    id: Date.now(),
    question: `${num1} + ${num2} = ?`,
    options,
    correctAnswer,
    timeLimit: 30
  };
}

function createGameRoom(player1Socket, player2Socket) {
  const roomId = `room_${Date.now()}`;
  const gameState = {
    roomId,
    players: {
      [player1Socket.id]: {
        socket: player1Socket,
        userId: player1Socket.userId,
        username: player1Socket.username,
        score: 0,
        currentQuestion: null,
        answered: false,
        ready: false
      },
      [player2Socket.id]: {
        socket: player2Socket,
        userId: player2Socket.userId,
        username: player2Socket.username,
        score: 0,
        currentQuestion: null,
        answered: false,
        ready: false
      }
    },
    gameStarted: false,
    gameEnded: false,
    startTime: null,
    duration: 120, // 2 minutes
    timer: null
  };
  
  gameRooms.set(roomId, gameState);
  
  // Join both players to the room
  player1Socket.join(roomId);
  player2Socket.join(roomId);
  player1Socket.roomId = roomId;
  player2Socket.roomId = roomId;
  
  return gameState;
}

async function saveMatchResult(gameState) {
  try {
    const players = Object.values(gameState.players);
    const player1 = players[0];
    const player2 = players[1];
    
    const winner = player1.score > player2.score ? player1 : 
                   player2.score > player1.score ? player2 : null;
    
    const matchDuration = gameState.startTime ? 
      Math.floor((Date.now() - gameState.startTime) / 1000) : 0;
    
    // Insert match record
    await dbPool.execute(`
      INSERT INTO matches (player1_id, player2_id, player1_score, player2_score, winner_id, match_duration)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      player1.userId,
      player2.userId,
      player1.score,
      player2.score,
      winner ? winner.userId : null,
      matchDuration
    ]);
    
    // Update user stats
    for (const player of players) {
      const isWinner = winner && winner.userId === player.userId;
      await dbPool.execute(`
        UPDATE users SET 
          games_played = games_played + 1,
          games_won = games_won + ?,
          total_score = total_score + ?
        WHERE id = ?
      `, [isWinner ? 1 : 0, player.score, player.userId]);
    }
    
    console.log(`✅ Match result saved for room ${gameState.roomId}`);
  } catch (error) {
    console.error('❌ Failed to save match result:', error);
  }
}

// API Routes
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.post('/api/login', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username || username.length < 2) {
      return res.status(400).json({ error: 'Username must be at least 2 characters' });
    }
    
    // Get or create user
    let [users] = await dbPool.execute('SELECT * FROM users WHERE username = ?', [username]);
    let user;
    
    if (users.length === 0) {
      const [result] = await dbPool.execute(
        'INSERT INTO users (username) VALUES (?)', 
        [username]
      );
      user = { id: result.insertId, username, games_played: 0, games_won: 0, total_score: 0 };
    } else {
      user = users[0];
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    
    res.json({ 
      success: true, 
      user,
      token 
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const [users] = await dbPool.execute(`
      SELECT username, games_played, games_won, total_score,
             ROUND((games_won / GREATEST(games_played, 1)) * 100, 1) as win_rate
      FROM users 
      WHERE games_played > 0
      ORDER BY total_score DESC, win_rate DESC
      LIMIT 10
    `);
    
    res.json(users);
  } catch (error) {
    console.error('Leaderboard error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔗 Player connected: ${socket.id}`);
  
  socket.on('authenticate', (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.userId = decoded.userId;
      socket.username = decoded.username;
      socket.authenticated = true;
      playerSockets.set(socket.userId, socket);
      
      socket.emit('authenticated', { 
        userId: decoded.userId, 
        username: decoded.username 
      });
      
      console.log(`✅ Player authenticated: ${socket.username} (${socket.userId})`);
    } catch (error) {
      socket.emit('authError', { message: 'Invalid token' });
      console.log(`❌ Authentication failed for socket: ${socket.id}`);
    }
  });
  
  socket.on('joinQueue', () => {
    if (!socket.authenticated) {
      return socket.emit('error', { message: 'Please authenticate first' });
    }
    
    // Check if player is already in queue or in game
    if (waitingQueue.find(p => p.userId === socket.userId) || socket.roomId) {
      return socket.emit('error', { message: 'Already in queue or in game' });
    }
    
    // Add to queue
    waitingQueue.push(socket);
    socket.emit('queueJoined', { position: waitingQueue.length });
    
    console.log(`🎯 ${socket.username} joined queue (${waitingQueue.length} waiting)`);
    
    // Try to match players
    if (waitingQueue.length >= 2) {
      const player1 = waitingQueue.shift();
      const player2 = waitingQueue.shift();
      
      if (player1.connected && player2.connected) {
        const gameState = createGameRoom(player1, player2);
        
        // Emit match found
        io.to(gameState.roomId).emit('matchFound', {
          roomId: gameState.roomId,
          opponent: {
            [player1.id]: { username: player2.username },
            [player2.id]: { username: player1.username }
          },
          countdown: 5
        });
        
        console.log(`🎮 Match created: ${player1.username} vs ${player2.username}`);
        
        // Start countdown
        setTimeout(() => {
          if (gameRooms.has(gameState.roomId)) {
            startGame(gameState);
          }
        }, 5000);
      }
    }
  });
  
  socket.on('leaveQueue', () => {
    const index = waitingQueue.findIndex(p => p.userId === socket.userId);
    if (index !== -1) {
      waitingQueue.splice(index, 1);
      socket.emit('queueLeft');
      console.log(`❌ ${socket.username} left queue`);
    }
  });
  
  socket.on('playerReady', () => {
    const roomId = socket.roomId;
    if (!roomId || !gameRooms.has(roomId)) return;
    
    const gameState = gameRooms.get(roomId);
    if (gameState.players[socket.id]) {
      gameState.players[socket.id].ready = true;
      
      // Check if both players are ready
      const players = Object.values(gameState.players);
      if (players.every(p => p.ready)) {
        startGame(gameState);
      }
    }
  });
  
  socket.on('submitAnswer', (data) => {
    const roomId = socket.roomId;
    if (!roomId || !gameRooms.has(roomId)) return;
    
    const gameState = gameRooms.get(roomId);
    const player = gameState.players[socket.id];
    
    if (!player || !player.currentQuestion || player.answered || gameState.gameEnded) {
      return;
    }
    
    player.answered = true;
    const isCorrect = data.answer === player.currentQuestion.correctAnswer;
    
    if (isCorrect) {
      const timeBonus = Math.max(0, 30 - Math.floor((Date.now() - player.questionStartTime) / 1000));
      player.score += 10 + timeBonus;
    }
    
    // Send new question immediately to this player
    const newQuestion = generateQuestion();
    player.currentQuestion = newQuestion;
    player.questionStartTime = Date.now();
    player.answered = false;
    
    socket.emit('questionResult', {
      correct: isCorrect,
      correctAnswer: player.currentQuestion.correctAnswer,
      score: player.score
    });
    
    socket.emit('newQuestion', {
      question: newQuestion,
      timeLimit: 30
    });
    
    // Broadcast scores to room
    const scores = {};
    Object.values(gameState.players).forEach(p => {
      scores[p.username] = p.score;
    });
    
    io.to(roomId).emit('scoreUpdate', scores);
  });
  
  // WebRTC signaling
  socket.on('rtc-offer', (data) => {
    socket.to(socket.roomId).emit('rtc-offer', data);
  });
  
  socket.on('rtc-answer', (data) => {
    socket.to(socket.roomId).emit('rtc-answer', data);
  });
  
  socket.on('rtc-ice-candidate', (data) => {
    socket.to(socket.roomId).emit('rtc-ice-candidate', data);
  });
  
  socket.on('disconnect', () => {
    console.log(`❌ Player disconnected: ${socket.id}`);
    
    // Remove from queue
    const queueIndex = waitingQueue.findIndex(p => p.id === socket.id);
    if (queueIndex !== -1) {
      waitingQueue.splice(queueIndex, 1);
    }
    
    // Handle game room cleanup
    if (socket.roomId && gameRooms.has(socket.roomId)) {
      const gameState = gameRooms.get(socket.roomId);
      
      // Notify opponent
      socket.to(socket.roomId).emit('opponentDisconnected');
      
      // End game and save results if game was in progress
      if (gameState.gameStarted && !gameState.gameEnded) {
        endGame(gameState);
      }
      
      // Clean up room after delay
      setTimeout(() => {
        gameRooms.delete(socket.roomId);
      }, 5000);
    }
    
    // Remove from player sockets
    if (socket.userId) {
      playerSockets.delete(socket.userId);
    }
  });
});

function startGame(gameState) {
  gameState.gameStarted = true;
  gameState.startTime = Date.now();
  
  // Send initial questions to both players
  Object.values(gameState.players).forEach(player => {
    const question = generateQuestion();
    player.currentQuestion = question;
    player.questionStartTime = Date.now();
    player.answered = false;
    
    player.socket.emit('gameStart', {
      question,
      duration: gameState.duration
    });
  });
  
  console.log(`🚀 Game started in room ${gameState.roomId}`);
  
  // Set game timer
  gameState.timer = setTimeout(() => {
    endGame(gameState);
  }, gameState.duration * 1000);
}

function endGame(gameState) {
  if (gameState.gameEnded) return;
  
  gameState.gameEnded = true;
  
  if (gameState.timer) {
    clearTimeout(gameState.timer);
  }
  
  const players = Object.values(gameState.players);
  const finalScores = {};
  let winner = null;
  let maxScore = -1;
  
  players.forEach(player => {
    finalScores[player.username] = player.score;
    if (player.score > maxScore) {
      maxScore = player.score;
      winner = player.username;
    } else if (player.score === maxScore && maxScore > 0) {
      winner = 'Draw';
    }
  });
  
  // Emit game results
  io.to(gameState.roomId).emit('gameEnd', {
    winner,
    finalScores,
    duration: gameState.startTime ? Math.floor((Date.now() - gameState.startTime) / 1000) : 0
  });
  
  console.log(`🏁 Game ended in room ${gameState.roomId}. Winner: ${winner}`);
  
  // Save match result
  saveMatchResult(gameState);
  
  // Cleanup
  setTimeout(() => {
    gameRooms.delete(gameState.roomId);
  }, 10000);
}

// Start server
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 Math Battle Server running on port ${PORT}`);
  });
});

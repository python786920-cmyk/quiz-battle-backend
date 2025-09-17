require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(cors());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Database connection
const dbConfig = {
  host: 'cashearnersofficial.xyz',
  user: 'cztldhwx_Auto_PostTg',
  password: 'Aptap786920',
  database: 'cztldhwx_Auto_PostTg',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

// Initialize database tables
async function initDatabase() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        wins INT DEFAULT 0,
        losses INT DEFAULT 0,
        total_score INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS matches (
        id VARCHAR(36) PRIMARY KEY,
        player1_id VARCHAR(36),
        player2_id VARCHAR(36),
        player1_score INT DEFAULT 0,
        player2_score INT DEFAULT 0,
        winner_id VARCHAR(36),
        game_duration INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (player1_id) REFERENCES users(id),
        FOREIGN KEY (player2_id) REFERENCES users(id),
        FOREIGN KEY (winner_id) REFERENCES users(id)
      )
    `);

    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

initDatabase();

// Game state management
const gameRooms = new Map();
const waitingQueue = [];
const activeConnections = new Map();

class GameRoom {
  constructor(roomId, player1, player2) {
    this.id = roomId;
    this.players = {
      [player1.id]: { ...player1, score: 0, answered: false },
      [player2.id]: { ...player2, score: 0, answered: false }
    };
    this.gameState = 'waiting'; // waiting, countdown, playing, finished
    this.currentQuestion = null;
    this.questionIndex = 0;
    this.gameTimer = 120; // 2 minutes
    this.startTime = null;
    this.timerInterval = null;
  }

  generateQuestion() {
    const num1 = Math.floor(Math.random() * 90) + 10; // 10-99
    const num2 = Math.floor(Math.random() * 90) + 10; // 10-99
    const correctAnswer = num1 + num2;
    
    // Generate wrong options
    const options = [correctAnswer];
    while (options.length < 4) {
      const wrongAnswer = correctAnswer + Math.floor(Math.random() * 20) - 10;
      if (wrongAnswer > 0 && !options.includes(wrongAnswer)) {
        options.push(wrongAnswer);
      }
    }
    
    // Shuffle options
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [options[i], options[j]] = [options[j], options[i]];
    }

    this.currentQuestion = {
      id: uuidv4(),
      question: `${num1} + ${num2} = ?`,
      options: options,
      correctAnswer: correctAnswer,
      questionNumber: this.questionIndex + 1
    };
    
    this.questionIndex++;
    
    // Reset answered status
    Object.keys(this.players).forEach(playerId => {
      this.players[playerId].answered = false;
    });

    return this.currentQuestion;
  }

  submitAnswer(playerId, answer) {
    if (this.gameState !== 'playing' || this.players[playerId].answered) {
      return false;
    }

    this.players[playerId].answered = true;
    
    if (answer === this.currentQuestion.correctAnswer) {
      this.players[playerId].score += 10;
    }

    return true;
  }

  allPlayersAnswered() {
    return Object.values(this.players).every(player => player.answered);
  }

  getGameState() {
    return {
      roomId: this.id,
      players: this.players,
      currentQuestion: this.currentQuestion,
      gameTimer: this.gameTimer,
      questionIndex: this.questionIndex,
      gameState: this.gameState
    };
  }
}

// API Routes
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Register user
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    await pool.execute(
      'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)',
      [userId, username, hashedPassword]
    );

    const token = jwt.sign({ userId, username }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '24h' });

    res.json({ success: true, token, user: { id: userId, username } });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Registration failed' });
    }
  }
});

// Login user
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const [rows] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
    
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '24h' });

    res.json({ 
      success: true, 
      token, 
      user: { 
        id: user.id, 
        username: user.username,
        wins: user.wins,
        losses: user.losses,
        total_score: user.total_score
      } 
    });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// Get leaderboard
app.get('/api/leaderboard', async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT username, wins, losses, total_score,
             CASE WHEN (wins + losses) > 0 THEN ROUND((wins / (wins + losses)) * 100, 1) ELSE 0 END as win_rate
      FROM users 
      WHERE (wins + losses) > 0
      ORDER BY wins DESC, total_score DESC 
      LIMIT 10
    `);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// Socket.IO Connection Management
io.on('connection', (socket) => {
  console.log(`🔌 User connected: ${socket.id}`);
  
  socket.on('authenticate', (token) => {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
      socket.userId = decoded.userId;
      socket.username = decoded.username;
      activeConnections.set(socket.userId, socket);
      
      socket.emit('authenticated', { success: true });
      console.log(`✅ User authenticated: ${socket.username}`);
    } catch (error) {
      socket.emit('authenticated', { success: false, error: 'Invalid token' });
    }
  });

  socket.on('joinQueue', () => {
    if (!socket.userId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    // Check if already in queue
    const existingIndex = waitingQueue.findIndex(p => p.id === socket.userId);
    if (existingIndex !== -1) {
      socket.emit('error', { message: 'Already in queue' });
      return;
    }

    const player = {
      id: socket.userId,
      username: socket.username,
      socketId: socket.id
    };

    if (waitingQueue.length === 0) {
      waitingQueue.push(player);
      socket.emit('queueStatus', { position: 1, message: 'Waiting for opponent...' });
    } else {
      // Match found!
      const opponent = waitingQueue.shift();
      const roomId = uuidv4();
      
      // Create game room
      const gameRoom = new GameRoom(roomId, opponent, player);
      gameRooms.set(roomId, gameRoom);

      // Join both players to room
      const opponentSocket = io.sockets.sockets.get(opponent.socketId);
      if (opponentSocket) {
        socket.join(roomId);
        opponentSocket.join(roomId);
        
        socket.roomId = roomId;
        opponentSocket.roomId = roomId;

        io.to(roomId).emit('matchFound', {
          roomId,
          opponent: opponent.id === socket.userId ? player : opponent,
          countdown: 5
        });

        // Start countdown
        let countdown = 5;
        const countdownInterval = setInterval(() => {
          countdown--;
          if (countdown > 0) {
            io.to(roomId).emit('countdown', countdown);
          } else {
            clearInterval(countdownInterval);
            startGame(roomId);
          }
        }, 1000);
      }
    }
  });

  socket.on('leaveQueue', () => {
    const index = waitingQueue.findIndex(p => p.id === socket.userId);
    if (index !== -1) {
      waitingQueue.splice(index, 1);
      socket.emit('leftQueue');
    }
  });

  socket.on('submitAnswer', (data) => {
    if (!socket.roomId) return;
    
    const gameRoom = gameRooms.get(socket.roomId);
    if (!gameRoom) return;

    const success = gameRoom.submitAnswer(socket.userId, data.answer);
    if (success) {
      io.to(socket.roomId).emit('scoreUpdate', {
        players: gameRoom.players,
        questionId: data.questionId
      });

      // If all players answered or 10 seconds passed, send next question
      if (gameRoom.allPlayersAnswered()) {
        setTimeout(() => {
          sendNextQuestion(socket.roomId);
        }, 2000); // 2 second delay to show results
      }
    }
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    socket.to(socket.roomId).emit('offer', data);
  });

  socket.on('answer', (data) => {
    socket.to(socket.roomId).emit('answer', data);
  });

  socket.on('iceCandidate', (data) => {
    socket.to(socket.roomId).emit('iceCandidate', data);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 User disconnected: ${socket.id}`);
    
    // Remove from queue
    const queueIndex = waitingQueue.findIndex(p => p.socketId === socket.id);
    if (queueIndex !== -1) {
      waitingQueue.splice(queueIndex, 1);
    }

    // Handle game disconnection
    if (socket.roomId) {
      const gameRoom = gameRooms.get(socket.roomId);
      if (gameRoom) {
        socket.to(socket.roomId).emit('opponentDisconnected');
        endGame(socket.roomId, 'disconnection');
      }
    }

    if (socket.userId) {
      activeConnections.delete(socket.userId);
    }
  });
});

function startGame(roomId) {
  const gameRoom = gameRooms.get(roomId);
  if (!gameRoom) return;

  gameRoom.gameState = 'playing';
  gameRoom.startTime = Date.now();

  // Start game timer
  gameRoom.timerInterval = setInterval(() => {
    gameRoom.gameTimer--;
    io.to(roomId).emit('timerUpdate', gameRoom.gameTimer);

    if (gameRoom.gameTimer <= 0) {
      endGame(roomId, 'timeout');
    }
  }, 1000);

  io.to(roomId).emit('gameStart', {
    message: 'Game Started!',
    gameTimer: gameRoom.gameTimer
  });

  // Send first question
  sendNextQuestion(roomId);
}

function sendNextQuestion(roomId) {
  const gameRoom = gameRooms.get(roomId);
  if (!gameRoom || gameRoom.gameState !== 'playing') return;

  const question = gameRoom.generateQuestion();
  io.to(roomId).emit('newQuestion', question);

  // Auto-advance after 10 seconds if no one answers
  setTimeout(() => {
    if (gameRoom.gameState === 'playing' && gameRoom.currentQuestion?.id === question.id) {
      sendNextQuestion(roomId);
    }
  }, 10000);
}

async function endGame(roomId, reason = 'completed') {
  const gameRoom = gameRooms.get(roomId);
  if (!gameRoom) return;

  gameRoom.gameState = 'finished';
  if (gameRoom.timerInterval) {
    clearInterval(gameRoom.timerInterval);
  }

  const playerIds = Object.keys(gameRoom.players);
  const player1 = gameRoom.players[playerIds[0]];
  const player2 = gameRoom.players[playerIds[1]];

  let winnerId = null;
  if (player1.score > player2.score) {
    winnerId = playerIds[0];
  } else if (player2.score > player1.score) {
    winnerId = playerIds[1];
  }

  // Save match to database
  try {
    const matchId = uuidv4();
    const gameDuration = gameRoom.startTime ? Math.floor((Date.now() - gameRoom.startTime) / 1000) : 0;

    await pool.execute(
      'INSERT INTO matches (id, player1_id, player2_id, player1_score, player2_score, winner_id, game_duration) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [matchId, playerIds[0], playerIds[1], player1.score, player2.score, winnerId, gameDuration]
    );

    // Update user stats
    for (const playerId of playerIds) {
      const isWinner = playerId === winnerId;
      const score = gameRoom.players[playerId].score;
      
      if (isWinner) {
        await pool.execute(
          'UPDATE users SET wins = wins + 1, total_score = total_score + ? WHERE id = ?',
          [score, playerId]
        );
      } else {
        await pool.execute(
          'UPDATE users SET losses = losses + 1, total_score = total_score + ? WHERE id = ?',
          [score, playerId]
        );
      }
    }
  } catch (error) {
    console.error('Error saving match:', error);
  }

  // Send game results
  io.to(roomId).emit('gameOver', {
    reason,
    results: {
      players: gameRoom.players,
      winner: winnerId ? gameRoom.players[winnerId] : null,
      duration: gameRoom.startTime ? Math.floor((Date.now() - gameRoom.startTime) / 1000) : 0
    }
  });

  // Clean up
  setTimeout(() => {
    gameRooms.delete(roomId);
  }, 10000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Math Battle Server running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});

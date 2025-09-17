const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later'
});
app.use('/api', limiter);

// MySQL Connection
const dbConfig = {
  host: 'cashearnersofficial.xyz',
  user: 'cztldhwx_Auto_PostTg',
  password: 'Aptap786920',
  database: 'cztldhwx_Auto_PostTg',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true
};

let db;

// Initialize Database
async function initDB() {
  try {
    db = mysql.createPool(dbConfig);
    
    // Create tables if not exist
    await db.execute(`
      CREATE TABLE IF NOT EXISTS math_players (
        id VARCHAR(36) PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        total_games INT DEFAULT 0,
        wins INT DEFAULT 0,
        losses INT DEFAULT 0,
        total_score INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS math_matches (
        id VARCHAR(36) PRIMARY KEY,
        player1_id VARCHAR(36),
        player2_id VARCHAR(36),
        player1_score INT DEFAULT 0,
        player2_score INT DEFAULT 0,
        winner_id VARCHAR(36),
        match_duration INT DEFAULT 120,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (player1_id) REFERENCES math_players(id),
        FOREIGN KEY (player2_id) REFERENCES math_players(id)
      )
    `);

    console.log('✅ Database connected and tables created');
  } catch (error) {
    console.error('❌ Database connection error:', error);
  }
}

initDB();

// Game State Management
const waitingQueue = new Map(); // playerId -> playerData
const activeMatches = new Map(); // matchId -> matchData
const playerSockets = new Map(); // playerId -> socketId

// Utility Functions
function generateMathQuestion() {
  const num1 = Math.floor(Math.random() * 90) + 10; // 10-99
  const num2 = Math.floor(Math.random() * 90) + 10; // 10-99
  const operators = ['+', '-', '*'];
  const operator = operators[Math.floor(Math.random() * operators.length)];
  
  let answer;
  switch(operator) {
    case '+': answer = num1 + num2; break;
    case '-': answer = num1 - num2; break;
    case '*': answer = num1 * num2; break;
  }
  
  // Generate 3 wrong options
  const options = [answer];
  while(options.length < 4) {
    let wrongAnswer;
    if(operator === '*') {
      wrongAnswer = answer + Math.floor(Math.random() * 20) - 10;
    } else {
      wrongAnswer = answer + Math.floor(Math.random() * 50) - 25;
    }
    if(!options.includes(wrongAnswer) && wrongAnswer > 0) {
      options.push(wrongAnswer);
    }
  }
  
  // Shuffle options
  for(let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }
  
  return {
    question: `${num1} ${operator} ${num2}`,
    options: options,
    correct: answer,
    correctIndex: options.indexOf(answer)
  };
}

async function createOrUpdatePlayer(playerId, username) {
  try {
    const [existing] = await db.execute('SELECT * FROM math_players WHERE id = ?', [playerId]);
    
    if(existing.length === 0) {
      await db.execute(
        'INSERT INTO math_players (id, username) VALUES (?, ?)',
        [playerId, username]
      );
    } else {
      await db.execute(
        'UPDATE math_players SET username = ? WHERE id = ?',
        [username, playerId]
      );
    }
  } catch(error) {
    console.error('Database error:', error);
  }
}

async function updatePlayerStats(playerId, won, score) {
  try {
    if(won) {
      await db.execute(
        'UPDATE math_players SET total_games = total_games + 1, wins = wins + 1, total_score = total_score + ? WHERE id = ?',
        [score, playerId]
      );
    } else {
      await db.execute(
        'UPDATE math_players SET total_games = total_games + 1, losses = losses + 1, total_score = total_score + ? WHERE id = ?',
        [score, playerId]
      );
    }
  } catch(error) {
    console.error('Database error:', error);
  }
}

// API Routes
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Math Battle API</title>
        <style>
            body { font-family: Arial; background: #0a0a0a; color: #fff; text-align: center; padding: 50px; }
            .status { color: #00ff88; font-size: 24px; margin: 20px 0; }
            .info { background: #111; padding: 20px; border-radius: 10px; margin: 20px 0; }
        </style>
    </head>
    <body>
        <h1>🚀 Math Battle Server</h1>
        <div class="status">✅ Server is Running!</div>
        <div class="info">
            <h3>API Status</h3>
            <p>Queue: ${waitingQueue.size} players waiting</p>
            <p>Active Matches: ${activeMatches.size}</p>
            <p>Connected Players: ${playerSockets.size}</p>
        </div>
        <div class="info">
            <h3>Endpoints</h3>
            <p>GET /health - Health check</p>
            <p>GET /api/leaderboard - Top players</p>
            <p>WebSocket - Real-time game events</p>
        </div>
    </body>
    </html>
  `);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    queue: waitingQueue.size,
    matches: activeMatches.size,
    players: playerSockets.size
  });
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const [rows] = await db.execute(`
      SELECT username, wins, total_games, total_score, 
             ROUND((wins / GREATEST(total_games, 1)) * 100, 1) as win_rate
      FROM math_players 
      WHERE total_games > 0
      ORDER BY wins DESC, total_score DESC 
      LIMIT 10
    `);
    res.json({ success: true, leaderboard: rows });
  } catch(error) {
    res.json({ success: false, error: 'Database error' });
  }
});

// Socket.IO Events
io.on('connection', (socket) => {
  console.log(`👤 Player connected: ${socket.id}`);

  socket.on('joinQueue', async (data) => {
    const { username } = data;
    if(!username || username.trim().length === 0) {
      socket.emit('error', { message: 'Username required' });
      return;
    }

    const playerId = uuidv4();
    const playerData = {
      id: playerId,
      socketId: socket.id,
      username: username.trim().substring(0, 20),
      joinedAt: Date.now()
    };

    // Create/update player in database
    await createOrUpdatePlayer(playerId, playerData.username);
    
    playerSockets.set(playerId, socket.id);
    socket.playerId = playerId;

    // Check if anyone waiting
    if(waitingQueue.size === 0) {
      waitingQueue.set(playerId, playerData);
      socket.emit('queueJoined', { position: 1 });
      console.log(`📝 ${username} joined queue`);
    } else {
      // Match found!
      const [opponentId, opponentData] = waitingQueue.entries().next().value;
      waitingQueue.delete(opponentId);

      const matchId = uuidv4();
      const matchData = {
        id: matchId,
        player1: playerData,
        player2: opponentData,
        scores: { [playerId]: 0, [opponentId]: 0 },
        questions: { [playerId]: null, [opponentId]: null },
        startTime: null,
        endTime: null,
        gameTimer: null,
        duration: 120000 // 2 minutes
      };

      activeMatches.set(matchId, matchData);

      // Join both to match room
      socket.join(matchId);
      const opponentSocket = io.sockets.sockets.get(opponentData.socketId);
      if(opponentSocket) {
        opponentSocket.join(matchId);
      }

      // Notify both players
      io.to(matchId).emit('matchFound', {
        matchId: matchId,
        opponent: playerId === playerData.id ? opponentData.username : playerData.username,
        countdown: 5
      });

      console.log(`⚔️ Match created: ${playerData.username} vs ${opponentData.username}`);

      // Start match after countdown
      setTimeout(() => {
        startMatch(matchId);
      }, 5000);
    }
  });

  socket.on('submitAnswer', (data) => {
    const { matchId, answer, questionId } = data;
    const playerId = socket.playerId;

    if(!playerId || !activeMatches.has(matchId)) return;

    const match = activeMatches.get(matchId);
    const question = match.questions[playerId];

    if(!question || question.id !== questionId) return;

    // Check answer
    const isCorrect = answer === question.correct;
    if(isCorrect) {
      match.scores[playerId] += 10; // 10 points per correct answer
    }

    // Send new question
    const newQuestion = generateMathQuestion();
    newQuestion.id = uuidv4();
    match.questions[playerId] = newQuestion;

    socket.emit('newQuestion', {
      question: newQuestion,
      isCorrect: isCorrect,
      score: match.scores[playerId]
    });

    // Update scores to room
    io.to(matchId).emit('scoreUpdate', {
      scores: match.scores,
      playerNames: {
        [match.player1.id]: match.player1.username,
        [match.player2.id]: match.player2.username
      }
    });
  });

  // WebRTC Signaling for Voice Chat
  socket.on('voice-offer', (data) => {
    socket.to(data.matchId).emit('voice-offer', {
      offer: data.offer,
      from: socket.playerId
    });
  });

  socket.on('voice-answer', (data) => {
    socket.to(data.matchId).emit('voice-answer', {
      answer: data.answer,
      from: socket.playerId
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.matchId).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.playerId
    });
  });

  socket.on('disconnect', () => {
    const playerId = socket.playerId;
    if(playerId) {
      waitingQueue.delete(playerId);
      playerSockets.delete(playerId);
      
      // Handle active match disconnect
      for(const [matchId, match] of activeMatches.entries()) {
        if(match.player1.id === playerId || match.player2.id === playerId) {
          socket.to(matchId).emit('opponentDisconnected');
          endMatch(matchId, true);
          break;
        }
      }
    }
    console.log(`👋 Player disconnected: ${socket.id}`);
  });
});

function startMatch(matchId) {
  if(!activeMatches.has(matchId)) return;

  const match = activeMatches.get(matchId);
  match.startTime = Date.now();

  // Generate first questions for both players
  const q1 = generateMathQuestion();
  const q2 = generateMathQuestion();
  q1.id = uuidv4();
  q2.id = uuidv4();

  match.questions[match.player1.id] = q1;
  match.questions[match.player2.id] = q2;

  // Send to players
  const p1Socket = io.sockets.sockets.get(match.player1.socketId);
  const p2Socket = io.sockets.sockets.get(match.player2.socketId);

  if(p1Socket) p1Socket.emit('gameStart', { question: q1, timeLeft: 120 });
  if(p2Socket) p2Socket.emit('gameStart', { question: q2, timeLeft: 120 });

  console.log(`🎮 Match started: ${matchId}`);

  // Set game timer
  match.gameTimer = setTimeout(() => {
    endMatch(matchId, false);
  }, match.duration);
}

async function endMatch(matchId, disconnected = false) {
  if(!activeMatches.has(matchId)) return;

  const match = activeMatches.get(matchId);
  match.endTime = Date.now();

  if(match.gameTimer) {
    clearTimeout(match.gameTimer);
  }

  const p1Score = match.scores[match.player1.id] || 0;
  const p2Score = match.scores[match.player2.id] || 0;

  let winnerId = null;
  if(p1Score > p2Score) winnerId = match.player1.id;
  else if(p2Score > p1Score) winnerId = match.player2.id;

  // Save match to database
  try {
    await db.execute(`
      INSERT INTO math_matches (id, player1_id, player2_id, player1_score, player2_score, winner_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [matchId, match.player1.id, match.player2.id, p1Score, p2Score, winnerId]);

    // Update player stats
    if(winnerId) {
      await updatePlayerStats(winnerId, true, winnerId === match.player1.id ? p1Score : p2Score);
      const loserId = winnerId === match.player1.id ? match.player2.id : match.player1.id;
      await updatePlayerStats(loserId, false, loserId === match.player1.id ? p1Score : p2Score);
    }
  } catch(error) {
    console.error('Database error saving match:', error);
  }

  // Send results
  const results = {
    matchId: matchId,
    scores: match.scores,
    winner: winnerId,
    disconnected: disconnected,
    duration: match.endTime - match.startTime
  };

  io.to(matchId).emit('gameEnd', results);

  console.log(`🏁 Match ended: ${matchId}, Winner: ${winnerId || 'Draw'}`);

  // Cleanup
  activeMatches.delete(matchId);
}

// Health check interval
setInterval(() => {
  console.log(`📊 Status - Queue: ${waitingQueue.size}, Matches: ${activeMatches.size}, Players: ${playerSockets.size}`);
}, 30000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Math Battle Server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for real-time connections`);
  console.log(`🎮 Game ready to battle!`);
});

const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const fetch = require('node-fetch');
const session = require('express-session');

const { db, init, seedAdmin } = require('./database');
const { baseStory } = require('./story');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({ secret: 'goddess-secret', resave: false, saveUninitialized: false }));
app.use(express.static(path.join(__dirname, 'public')));

init();
seedAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);

function ensureAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect('/login');
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user) return res.send('Invalid credentials');
    bcrypt.compare(password, user.password_hash, (err, result) => {
      if (result) {
        req.session.userId = user.id;
        res.redirect('/chat');
      } else {
        res.send('Invalid credentials');
      }
    });
  });
});

app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

app.post('/register', (req, res) => {
  const { email, password, name, age, likes, work, religion, past } = req.body;
  bcrypt.hash(password, 10, (err, hash) => {
    db.run('INSERT INTO users (email, password_hash, name, age, likes, work, religion, past) VALUES (?,?,?,?,?,?,?,?)',
      [email, hash, name, age, likes, work, religion, past], function(err){
        if (err) return res.send('Error registering');
        req.session.userId = this.lastID;
        res.redirect('/chat');
      });
  });
});

app.get('/chat', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.post('/chat', ensureAuth, async (req, res) => {
  const userId = req.session.userId;
  const userMessage = req.body.message;
  db.run('INSERT INTO messages (user_id, is_user, message) VALUES (?,?,?)', [userId, 1, userMessage]);

  db.get('SELECT * FROM users WHERE id = ?', [userId], async (err, user) => {
    const history = [];
    db.all('SELECT is_user, message FROM messages WHERE user_id = ? ORDER BY id ASC LIMIT 20', [userId], async (err, rows) => {
      rows.forEach(r => history.push({ role: r.is_user ? 'user' : 'assistant', content: r.message }));
      const payload = {
        model: 'openrouter/cinematika',
        messages: [
          { role: 'system', content: baseStory + ` User info: name=${user.name}, age=${user.age}, likes=${user.likes}, work=${user.work}, religion=${user.religion}, past=${user.past}` },
          ...history,
          { role: 'user', content: userMessage }
        ]
      };
      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
          },
          body: JSON.stringify(payload)
        });
        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || '...';
        db.run('INSERT INTO messages (user_id, is_user, message) VALUES (?,?,?)', [userId, 0, reply]);
        res.json({ reply });
      } catch(e) {
        console.error(e);
        res.status(500).send('Error contacting OpenRouter');
      }
    });
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

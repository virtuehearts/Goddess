const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
// Use Node 20's built-in fetch which supports streaming
const session = require('express-session');

const { db, init, seedAdmin } = require('./database');
const { baseStory } = require('./story');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function refreshCredits(userId, cb) {
  db.get('SELECT credits, last_credit_date, unlimited_credits FROM users WHERE id = ?', [userId], (err, user) => {
    if (err) return cb(err);
    if (user.unlimited_credits) return cb(null, user);
    if (user.last_credit_date !== today()) {
      db.run('UPDATE users SET credits = 20, last_credit_date = ? WHERE id = ?', [today(), userId], err2 => {
        if (err2) return cb(err2);
        db.get('SELECT credits, last_credit_date, unlimited_credits FROM users WHERE id = ?', [userId], cb);
      });
    } else {
      cb(null, user);
    }
  });
}

// Simple memory parser to store user-provided information
function updateMemories(userId, text) {
  const patterns = [
    { regex: /my name is ([a-zA-Z ]+)/i, field: 'name' },
    { regex: /i am ([a-zA-Z ]+) years old/i, field: 'age' },
    { regex: /i live in ([a-zA-Z ,]+)/i, field: 'location' },
    { regex: /i am from ([a-zA-Z ,]+)/i, field: 'location' },
    { regex: /my hobbies? (?:are|include) ([a-zA-Z ,]+)/i, field: 'hobbies' },
    { regex: /i like ([a-zA-Z ,]+)/i, field: 'likes' },
    { regex: /my favorite movies? (?:are|is) ([a-zA-Z ,]+)/i, field: 'movies' },
    { regex: /my favorite music (?:is|are) ([a-zA-Z ,]+)/i, field: 'music' }
  ];

  patterns.forEach(p => {
    const m = text.match(p.regex);
    if (m && m[1]) {
      const value = m[1].trim();
      db.run(`UPDATE users SET ${p.field} = ? WHERE id = ?`, [value, userId]);
    }
  });
}

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
        refreshCredits(user.id, () => {
          res.redirect('/chat');
        });
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
  const { email, password } = req.body;
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) return res.send('Error registering');
    db.run(`INSERT INTO users (email, password_hash, credits, last_credit_date) VALUES (?, ?, 20, ?)`,
      [email, hash, today()], function(err){
        if (err) return res.send('Error registering');
        req.session.userId = this.lastID;
        refreshCredits(this.lastID, () => {
          res.redirect('/chat');
        });
      });
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/preferences', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preferences.html'));
});

app.get('/chat', ensureAuth, (req, res) => {
  refreshCredits(req.session.userId, () => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
  });
});

app.get('/treasury', ensureAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'treasury.html'));
});

app.get('/credits', ensureAuth, (req, res) => {
  const userId = req.session.userId;
  refreshCredits(userId, (err, user) => {
    if (err) return res.status(500).send('Error');
    res.json({ credits: user.unlimited_credits ? 'unlimited' : user.credits });
  });
});

// simple endpoint to mark a user as donated
app.post('/donated', ensureAuth, (req, res) => {
  const userId = req.session.userId;
  db.run('UPDATE users SET unlimited_credits = 1 WHERE id = ?', [userId], err => {
    if (err) return res.status(500).send('Error');
    res.sendStatus(200);
  });
});

app.post('/chat', ensureAuth, async (req, res) => {
  const userId = req.session.userId;
  const userMessage = req.body.message;
  updateMemories(userId, userMessage);
  refreshCredits(userId, (err, user) => {
    if (err) return res.status(500).send('Error');
    if (!user.unlimited_credits && user.credits <= 0) {
      return res.json({ reply: 'You have no credits left for today.' });
    }
    if (!user.unlimited_credits) {
      db.run('UPDATE users SET credits = credits - 1 WHERE id = ?', [userId]);
    }
    db.run('INSERT INTO messages (user_id, is_user, message) VALUES (?,?,?)', [userId, 1, userMessage]);

    db.get('SELECT * FROM users WHERE id = ?', [userId], async (err2, userInfo) => {
      const history = [];
      db.all('SELECT is_user, message FROM messages WHERE user_id = ? ORDER BY id ASC LIMIT 20', [userId], async (err3, rows) => {
        rows.forEach(r => history.push({ role: r.is_user ? 'user' : 'assistant', content: r.message }));
        const payload = {
          // Use the Shisa v2 Llama3.3 model for improved roleplay capabilities
          model: 'shisa-ai/shisa-v2-llama3.3-70b:free',
          stream: true,
          messages: [
            { role: 'system', content: baseStory + ` User info: name=${userInfo.name || ''}, age=${userInfo.age || ''}, gender=${userInfo.gender || ''}, location=${userInfo.location || ''}, personality=${userInfo.personality || ''}, hobbies=${userInfo.hobbies || ''}, movies=${userInfo.movies || ''}, music=${userInfo.music || ''}, likes=${userInfo.likes || ''}, work=${userInfo.work || ''}, religion=${userInfo.religion || ''}, past=${userInfo.past || ''}` },
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

          let reply = '';
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(l => l.trim().startsWith('data: '));
            for (const line of lines) {
              const dataStr = line.replace(/^data:\s*/, '').trim();
              if (dataStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) reply += delta;
              } catch (_) {}
            }
          }

          if (!reply) reply = '...';
          reply = reply.replace(/—/g, '-');
          db.run('INSERT INTO messages (user_id, is_user, message) VALUES (?,?,?)', [userId, 0, reply]);
          res.json({ reply });
        } catch(e) {
          console.error(e);
          res.status(500).send('Error contacting OpenRouter');
        }
      });
    });
  });
});

app.post('/tasks', ensureAuth, (req, res) => {
  const { task } = req.body;
  const userId = req.session.userId;
  db.run('INSERT INTO tasks (user_id, task) VALUES (?,?)', [userId, task], err => {
    if (err) return res.status(500).send('Error adding task');
    res.sendStatus(200);
  });
});

app.get('/tasks', ensureAuth, (req, res) => {
  const userId = req.session.userId;
  db.all('SELECT id, task, completed FROM tasks WHERE user_id = ?', [userId], (err, rows) => {
    if (err) return res.status(500).send('Error fetching tasks');
    res.json(rows);
  });
});

app.post('/tasks/:id/complete', ensureAuth, (req, res) => {
  const userId = req.session.userId;
  const id = req.params.id;
  db.run('UPDATE tasks SET completed = 1 WHERE id = ? AND user_id = ?', [id, userId], err => {
    if (err) return res.status(500).send('Error updating task');
    db.run('UPDATE users SET credits = credits + 5 WHERE id = ?', [userId]);
    res.sendStatus(200);
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

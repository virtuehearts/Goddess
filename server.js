const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const bcrypt = require('bcrypt');
const session = require('express-session');
const fs = require('fs');

// Support environments where global fetch is not available
const fetch =
  typeof global.fetch === 'function'
    ? global.fetch
    : (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const { db, init, seedAdmin } = require('./database');
const { baseStory } = require('./story');
const { lore } = require('./lore');

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

// Extract internal notes like *(note)* from LLM output
function parseThoughts(text) {
  const thoughts = [];
  const starPattern = /\*\([^)]*\)\*/g;
  const notePattern = /\((?:\s*(?:note|ooc|thought|aside)[^)]*)\)/gi;
  const bracketPattern = /\[(?:\s*(?:note|ooc|thought|aside)[^\]]*)\]/gi;

  let clean = text
    .replace(starPattern, m => {
      const inner = m.slice(1, -1).trim();
      if (inner) thoughts.push(inner.replace(/^\(|\)$/g, ''));
      return '';
    })
    .replace(notePattern, m => {
      const inner = m.slice(1, -1).trim();
      if (inner) thoughts.push(inner);
      return '';
    })
    .replace(bracketPattern, m => {
      const inner = m.slice(1, -1).trim();
      if (inner) thoughts.push(inner);
      return '';
    })
    .replace(/\s{2,}/g, ' ') // collapse extra spaces
    .trim();

  if ((clean.startsWith('"') && clean.endsWith('"')) ||
      (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim();
  }

  return { clean, thoughts };
}

function extractCommand(text) {
  let track = null;
  let clean = text.replace(/\[(?:play|audio):([^\]]+)\]/i, (_, t) => {
    track = t.trim();
    return '';
  }).trim();
  return { text: clean, track };
}

function detectTags(text) {
  const lower = text.toLowerCase();
  const tags = [];
  if (
    lower.includes('donate') ||
    lower.includes('help support') ||
    lower.includes('how can i give')
  ) {
    tags.push('donation_inquiry');
  }
  return tags;
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_PATH = (process.env.BASE_PATH || '/chat').replace(/\/+$/, '');

function withBase(p) {
  return `${BASE_PATH}${p}`;
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'goddess-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    path: BASE_PATH || '/',
    sameSite: 'lax'
  }
}));
app.use(BASE_PATH, express.static(path.join(__dirname, 'public')));

init();
seedAdmin(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);

if (BASE_PATH) {
  app.get('/', (req, res) => res.redirect(BASE_PATH));
}

function ensureAuth(req, res, next) {
  if (req.session.userId) return next();
  res.redirect(withBase('/login'));
}

function sendHtml(res, file) {
  fs.readFile(path.join(__dirname, 'public', file), 'utf8', (err, data) => {
    if (err) return res.status(500).send('Error');
    res.set('Content-Type', 'text/html');
    res.send(data.replace(/%BASE_PATH%/g, BASE_PATH));
  });
}

app.get(BASE_PATH === '' ? '/' : BASE_PATH, (req, res) => {
  sendHtml(res, 'index.html');
});
if (BASE_PATH) {
  app.get(withBase('/'), (req, res) => sendHtml(res, 'index.html'));
}

app.get(withBase('/login'), (req, res) => {
  sendHtml(res, 'login.html');
});

app.post(withBase('/login'), (req, res) => {
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (err || !user) return res.send('Invalid credentials');
    bcrypt.compare(password, user.password_hash, (err, result) => {
      if (result) {
        req.session.userId = user.id;
        refreshCredits(user.id, () => {
          res.redirect(withBase('/chat'));
        });
      } else {
        res.send('Invalid credentials');
      }
    });
  });
});

app.get(withBase('/register'), (req, res) => {
  sendHtml(res, 'register.html');
});

app.post(withBase('/register'), (req, res) => {
  const { email, password } = req.body;
  bcrypt.hash(password, 10, (err, hash) => {
    if (err) return res.send('Error registering');
    db.run(`INSERT INTO users (email, password_hash, credits, last_credit_date) VALUES (?, ?, 20, ?)`,
      [email, hash, today()], function(err){
        if (err) return res.send('Error registering');
        req.session.userId = this.lastID;
        refreshCredits(this.lastID, () => {
          res.redirect(withBase('/chat'));
        });
      });
  });
});

app.get(withBase('/logout'), (req, res) => {
  req.session.destroy(() => {
    res.redirect(withBase('/login'));
  });
});

app.get(withBase('/preferences'), ensureAuth, (req, res) => {
  sendHtml(res, 'preferences.html');
});

app.get(withBase('/chat'), ensureAuth, (req, res) => {
  refreshCredits(req.session.userId, () => {
    sendHtml(res, 'chat.html');
  });
});

app.get(withBase('/treasury'), ensureAuth, (req, res) => {
  sendHtml(res, 'treasury.html');
});

app.get(withBase('/credits'), ensureAuth, (req, res) => {
  const userId = req.session.userId;
  refreshCredits(userId, (err, user) => {
    if (err) return res.status(500).send('Error');
    res.json({ credits: user.unlimited_credits ? 'unlimited' : user.credits });
  });
});

app.get(withBase('/me'), ensureAuth, (req, res) => {
  const userId = req.session.userId;
  refreshCredits(userId, () => {
    db.get('SELECT email, created_at, credits, unlimited_credits FROM users WHERE id = ?', [userId], (err, row) => {
      if (err) return res.status(500).send('Error');
      if (row) row.credits = row.unlimited_credits ? 'unlimited' : row.credits;
      res.json(row);
    });
  });
});

app.get(withBase('/conversations'), ensureAuth, (req, res) => {
  const userId = req.session.userId;
  db.all('SELECT id, name FROM conversations WHERE user_id = ? ORDER BY id DESC', [userId], (err, rows) => {
    if (err) return res.status(500).send('Error');
    res.json(rows);
  });
});

app.post(withBase('/conversations'), ensureAuth, (req, res) => {
  const userId = req.session.userId;
  const name = req.body.name || 'New Chat';
  db.run('INSERT INTO conversations (user_id, name) VALUES (?,?)', [userId, name], function(err){
    if (err) return res.status(500).send('Error');
    res.json({ id: this.lastID });
  });
});

app.post(withBase('/conversations/:id/rename'), ensureAuth, (req, res) => {
  const userId = req.session.userId;
  const convId = req.params.id;
  const name = req.body.name || 'New Chat';
  db.run('UPDATE conversations SET name = ? WHERE id = ? AND user_id = ?', [name, convId, userId], function(err){
    if (err) return res.status(500).send('Error');
    res.json({ success: true });
  });
});

app.get(withBase('/conversations/:id/messages'), ensureAuth, (req, res) => {
  const userId = req.session.userId;
  const convId = req.params.id;
  db.all('SELECT is_user, message FROM messages WHERE user_id=? AND conversation_id=? ORDER BY id ASC', [userId, convId], (err, rows) => {
    if (err) return res.status(500).send('Error');
    res.json(rows);
  });
});

// simple endpoint to mark a user as donated
app.post(withBase('/donated'), ensureAuth, (req, res) => {
  const userId = req.session.userId;
  db.run('UPDATE users SET unlimited_credits = 1 WHERE id = ?', [userId], err => {
    if (err) return res.status(500).send('Error');
    res.sendStatus(200);
  });
});

app.post(withBase('/chat'), ensureAuth, async (req, res) => {
  const userId = req.session.userId;
  const conversationId = req.body.conversationId;
  const userMessage = req.body.message;
  updateMemories(userId, userMessage);
  refreshCredits(userId, (err, user) => {
    if (err) return res.status(500).send('Error');
    if (!user.unlimited_credits && user.credits <= 0) {
      return res.json({ reply: 'You have no credits left for today. Please donate to the treasury or wait until tomorrow for credits to replenish.' });
    }
    if (!user.unlimited_credits) {
      db.run('UPDATE users SET credits = credits - 1 WHERE id = ?', [userId]);
    }
    db.run('INSERT INTO messages (user_id, conversation_id, is_user, message) VALUES (?,?,?,?)', [userId, conversationId, 1, userMessage]);

    db.get('SELECT * FROM users WHERE id = ?', [userId], async (err2, userInfo) => {
      const history = [];
      db.all('SELECT is_user, message FROM messages WHERE user_id = ? AND conversation_id = ? ORDER BY id ASC LIMIT 20', [userId, conversationId], async (err3, rows) => {
        rows.forEach(r => history.push({ role: r.is_user ? 'user' : 'assistant', content: r.message }));
        const tags = detectTags(userMessage);
        const messages = [
          { role: 'system', content: `${baseStory}\n${lore}\nUser info: name=${userInfo.name || ''}, age=${userInfo.age || ''}, gender=${userInfo.gender || ''}, location=${userInfo.location || ''}, personality=${userInfo.personality || ''}, hobbies=${userInfo.hobbies || ''}, movies=${userInfo.movies || ''}, music=${userInfo.music || ''}, likes=${userInfo.likes || ''}, work=${userInfo.work || ''}, religion=${userInfo.religion || ''}, past=${userInfo.past || ''}` },
          ...history,
          { role: 'user', content: userMessage }
        ];
        if (tags.length) {
          messages.push({ role: 'system', content: `tags: ${tags.join(',')}` });
        }
        const payload = {
          // Use the Shisa v2 Llama3.3 model for improved roleplay capabilities
          model: 'shisa-ai/shisa-v2-llama3.3-70b:free',
          stream: true,
          messages
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
          const decoder = new TextDecoder();
          if (response.body.getReader) {
            const reader = response.body.getReader();
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
          } else {
            for await (const chunk of response.body) {
              const chunkStr = decoder.decode(chunk);
              const lines = chunkStr.split('\n').filter(l => l.trim().startsWith('data: '));
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
          }

          if (!reply) reply = '...';
          reply = reply.replace(/—/g, '-');
          const { clean, thoughts } = parseThoughts(reply);
          const { text: finalText, track } = extractCommand(clean);
          thoughts.forEach(t => {
            db.run('INSERT INTO thoughts (user_id, conversation_id, thought) VALUES (?,?,?)', [userId, conversationId, t]);
          });
          db.run('INSERT INTO messages (user_id, conversation_id, is_user, message) VALUES (?,?,?,?)', [userId, conversationId, 0, finalText]);
          res.json({ reply: finalText, track });
        } catch(e) {
          console.error(e);
          res.status(500).send('Error contacting OpenRouter');
        }
      });
    });
  });
});

app.post(withBase('/tasks'), ensureAuth, (req, res) => {
  const { task } = req.body;
  const userId = req.session.userId;
  db.run('INSERT INTO tasks (user_id, task) VALUES (?,?)', [userId, task], err => {
    if (err) return res.status(500).send('Error adding task');
    res.sendStatus(200);
  });
});

app.get(withBase('/tasks'), ensureAuth, (req, res) => {
  const userId = req.session.userId;
  db.all('SELECT id, task, completed FROM tasks WHERE user_id = ?', [userId], (err, rows) => {
    if (err) return res.status(500).send('Error fetching tasks');
    res.json(rows);
  });
});

app.post(withBase('/tasks/:id/complete'), ensureAuth, (req, res) => {
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

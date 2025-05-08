const express = require("express");
const http = require("http");
const mineflayer = require('mineflayer')
const pvp = require('mineflayer-pvp').plugin
const { pathfinder, Movements, goals} = require('mineflayer-pathfinder')
const armorManager = require('mineflayer-armor-manager')
const mc = require('minecraft-protocol');
const AutoAuth = require('mineflayer-auto-auth');
const WebSocket = require('ws');

// Configuration
const CONFIG = {
  host: 'mc1496499.fmcs.cloud',
  port: 25811,
  username: 'Bot',
  auth: 'bot112022',
  version: false,
  guardRadius: 16,
  reconnectDelay: 5000,
  keepAliveInterval: 224000
};

// Express setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.get("/", (_, res) => res.sendFile(__dirname + "/index.html"));

// Global bot instance
let bot = null;

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('Client connected');
  
  // Send initial player list
  if (bot && bot.players) {
    ws.send(JSON.stringify({
      type: 'players',
      players: bot.players
    }));
  }
  
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'chat' && bot) {
        // Send message with user name if provided, otherwise use console
        const prefix = data.userName ? data.userName : '<console>';
        bot.chat(`${prefix}: ${data.message}`);
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Function to broadcast messages to all connected clients
function broadcast(data) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Keep alive function with error handling
function keepAlive() {
  try {
    if (process.env.PROJECT_DOMAIN) {
      http.get(`http://${process.env.PROJECT_DOMAIN}.repl.co/`, (res) => {
        if (res.statusCode !== 200) {
          console.log(`Keep-alive request failed with status: ${res.statusCode}`);
        }
      }).on('error', (err) => {
        console.log('Keep-alive request failed:', err.message);
      });
    }
  } catch (err) {
    console.log('Error in keep-alive:', err.message);
  }
}

// Start keep-alive interval only if PROJECT_DOMAIN is set
if (process.env.PROJECT_DOMAIN) {
  setInterval(keepAlive, CONFIG.keepAliveInterval);
}

function createBot() {
  try {
    bot = mineflayer.createBot({
      host: CONFIG.host,
      version: CONFIG.version,
      username: CONFIG.username,
      port: CONFIG.port,
      plugins: [AutoAuth],
      AutoAuth: CONFIG.auth
    });

    bot.loadPlugin(pvp);
    bot.loadPlugin(armorManager);
    bot.loadPlugin(pathfinder);

    let guardPos = null;
    let isGuarding = false;

    // Chat message logging
    bot.on('message', (message) => {
      const timestamp = new Date().toLocaleTimeString();
      const logMessage = `[${timestamp}] ${message.toString()}`;
      console.log(logMessage);
      broadcast({ type: 'console', message: logMessage });
    });

    // Player join/leave logging
    bot.on('playerJoined', (player) => {
      const timestamp = new Date().toLocaleTimeString();
      const logMessage = `[${timestamp}] ${player.username} joined the game`;
      console.log(logMessage);
      broadcast({ type: 'console', message: logMessage });
      broadcast({ type: 'players', players: bot.players });
    });

    bot.on('playerLeft', (player) => {
      const timestamp = new Date().toLocaleTimeString();
      const logMessage = `[${timestamp}] ${player.username} left the game`;
      console.log(logMessage);
      broadcast({ type: 'console', message: logMessage });
      broadcast({ type: 'players', players: bot.players });
    });

    function guardArea(pos) {
      guardPos = pos.clone();
      isGuarding = true;
      if (!bot.pvp.target) {
        moveToGuardPos();
      }
    }

    function stopGuarding() {
      guardPos = null;
      isGuarding = false;
      bot.pvp.stop();
      bot.pathfinder.setGoal(null);
    }

    function moveToGuardPos() {
      if (!guardPos) return;
      const mcData = require('minecraft-data')(bot.version);
      bot.pathfinder.setMovements(new Movements(bot, mcData));
      bot.pathfinder.setGoal(new goals.GoalBlock(guardPos.x, guardPos.y, guardPos.z));
    }

    bot.on('spawn', () => {
      const logMessage = 'Bot spawned!';
      console.log(logMessage);
      broadcast({ type: 'console', message: logMessage });
      bot.setControlState('jump', true);
      setupInventoryManagement();
    });

    function setupInventoryManagement() {
      bot.on('playerCollect', (collector, itemDrop) => {
        if (collector !== bot.entity) return;

        setTimeout(() => {
          const swords = bot.inventory.items().filter(item => item.name.includes('sword'));
          if (swords.length > 0) {
            const bestSword = swords.reduce((a, b) => (a.attackDamage > b.attackDamage ? a : b));
            bot.equip(bestSword, 'hand');
          }

          const shield = bot.inventory.items().find(item => item.name.includes('shield'));
          if (shield) bot.equip(shield, 'off-hand');
        }, 150);
      });
    }

    bot.on('stoppedAttacking', () => {
      if (isGuarding) {
        moveToGuardPos();
      }
    });

    bot.on('physicTick', () => {
      if (bot.pvp.target) return;
      if (bot.pathfinder.isMoving()) return;

      const entity = bot.nearestEntity();
      if (entity) bot.lookAt(entity.position.offset(0, entity.height, 0));
    });

    bot.on('physicTick', () => {
      if (!isGuarding) return;
      const filter = e => e.type === 'mob' && e.position.distanceTo(bot.entity.position) < CONFIG.guardRadius &&
                          e.mobType !== 'Armor Stand';
      const entity = bot.nearestEntity(filter);
      if (entity) {
        bot.pvp.attack(entity);
      }
    });

    bot.on('chat', (username, message) => {
      const args = message.split(' ');
      const command = args[0].toLowerCase();

      switch (command) {
        case 'guard':
          const player = bot.players[username];
          if (player) {
            bot.chat('I will guard this area!');
            guardArea(player.entity.position);
          } else {
            bot.chat('I cannot see you!');
          }
          break;

        case 'stop':
          bot.chat('Stopping guard duty!');
          stopGuarding();
          break;

        case 'come':
          const targetPlayer = bot.players[username];
          if (targetPlayer) {
            bot.chat('Coming to you!');
            guardArea(targetPlayer.entity.position);
          }
          break;

        case 'status':
          bot.chat(`Status: ${isGuarding ? 'Guarding' : 'Idle'}`);
          break;
      }
    });

    bot.on('kicked', (reason) => {
      const logMessage = `Bot was kicked: ${reason}`;
      console.log(logMessage);
      broadcast({ type: 'console', message: logMessage });
      setTimeout(createBot, CONFIG.reconnectDelay);
    });

    bot.on('error', (err) => {
      const logMessage = `Bot encountered an error: ${err}`;
      console.log(logMessage);
      broadcast({ type: 'console', message: logMessage });
      setTimeout(createBot, CONFIG.reconnectDelay);
    });

    bot.on('end', () => {
      const logMessage = 'Bot disconnected, attempting to reconnect...';
      console.log(logMessage);
      broadcast({ type: 'console', message: logMessage });
      setTimeout(createBot, CONFIG.reconnectDelay);
    });

  } catch (err) {
    console.error('Error creating bot:', err);
    setTimeout(createBot, CONFIG.reconnectDelay);
  }
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  createBot();
});

//// Remember to subscribe to my channels!
/// www.youtube.com/c/JinMoriYT
/// www.youtube.com/channel/UC1SR0lQSDfdaSMhmUiaMitg

import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser } from '@whiskeysockets/baileys';
import fs from 'fs-extra';
import pino from 'pino';
import path from 'path';
import chalk from 'chalk';
import readline from 'readline';
import { fileURLToPath, pathToFileURL } from 'url';
import crypto from 'crypto';
import os from 'os';
import delay from 'delay';

// استدعاء الموديولات والملفات المباشرة
import { handleMessages, initializePlugins } from './handlers/messages.js';
import elitePro from './handlers/elite-pro.js';
import config from './nova/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// مسارات ثابتة للاتصال والشفرات
const sessionDir = path.join(__dirname, 'ملف_الاتصال');
const passwordFile = path.join(sessionDir, 'Password.txt'); 
const errorFilePath = path.join(__dirname, 'node_modules', 'axios', 'errorMsg.txt');

// مفتاح التشفير
const SECRET_KEY = crypto.createHash('sha256').update('jnd_secure_session_v1').digest();

function encryptText(text) {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', SECRET_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return iv.toString('base64') + ':' + encrypted;
  } catch (e) { return null; }
}

function decryptTextSafe(text) {
  try {
    const index = text.indexOf(':');
    if (index === -1) return null;
    const ivBase64 = text.slice(0, index);
    const data = text.slice(index + 1);
    const iv = Buffer.from(ivBase64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', SECRET_KEY, iv);
    let decrypted = decipher.update(data, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) { return null; }
}

if (fs.existsSync(errorFilePath)) {
  try {
    const content = fs.readFileSync(errorFilePath, 'utf8').trim();
    if (!/^[A-Za-z0-9+/]{20,}={0,2}:[A-Za-z0-9+/]+={0,2}$/.test(content)) {
      fs.writeFileSync(errorFilePath, encryptText(content));
    }
  } catch (err) {}
}

const question = (text) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(text, (answer) => { rl.close(); resolve(answer); });
  });

function getSystemFingerprint() {
    try {
        const platform = os.platform();
        const arch = os.arch();
        const user = os.userInfo().username || 'unknown';
        const cpus = os.cpus();
        const cpuModel = cpus.length > 0 ? cpus[0].model : 'generic_cpu';
        
        const sysData = `${platform}_${arch}_${user}_${cpuModel}`;
        return crypto.createHash('md5').update(sysData).digest('hex');
    } catch (e) {
        return 'fallback_fingerprint_' + os.arch(); 
    }
}

let play, playError, playLogout, logger;
let themeData = { asciiArt: '', soundPath: '', themeColor: 'FF6BFF' };

async function bootstrapSystem() {
    try {
        const utilsPath = path.join(__dirname, 'utils');
        const loggerModule = await import(pathToFileURL(path.join(utilsPath, 'console.js')).href);
        logger = loggerModule.default;
        
        const soundModule = await import(pathToFileURL(path.join(utilsPath, 'sound.js')).href);
        const soundStateFile = path.join(__dirname, 'nova', 'themes', 'soundState.txt');
        
        const isSoundEnabled = () => {
            try {
                if (fs.existsSync(soundStateFile)) {
                    return fs.readFileSync(soundStateFile, 'utf-8').trim() === '[on]';
                }
                return false;
            } catch (e) { return false; }
        };

        play = (filePath) => { if(isSoundEnabled()) soundModule.play(filePath); };
        playError = () => { if(isSoundEnabled()) soundModule.playError(); };
        playLogout = () => { if(isSoundEnabled()) soundModule.playLogout(); };

    } catch (e) { 
        logger = console;
        play = () => {}; playError = () => {}; playLogout = () => {};
    }

    try {
        const settingsPath = path.join(__dirname, 'nova', 'themes', 'settings.txt');
        if (fs.existsSync(settingsPath)) {
            const folderName = fs.readFileSync(settingsPath, 'utf-8').trim().replace(/[\[\]]/g, '');
            const themeFolder = path.join(__dirname, 'nova', 'themes', folderName);
            if (fs.existsSync(themeFolder)) {
                const jsFiles = (await fs.readdir(themeFolder)).filter(f => f.endsWith('.js'));
                if (jsFiles.length > 0) {
                    const asciiArtPath = path.join(themeFolder, jsFiles[0]);
                    const themeArt = await import(pathToFileURL(asciiArtPath).href);
                    const mp3Files = (await fs.readdir(themeFolder)).filter(f => f.endsWith('.mp3'));
                    const soundPath = mp3Files.length ? path.join(themeFolder, mp3Files[0]) : '';
                    const themeContent = fs.readFileSync(asciiArtPath, 'utf-8');
                    const match = themeContent.match(/chalk\.hex\(['"](#(?:[0-9A-Fa-f]{6}))['"]\)/);
                    themeData = { asciiArt: themeArt.asciiArt || '', soundPath, themeColor: match ? match[1] : 'FF6BFF' };
                }
            }
        }
    } catch (e) {}
}

export async function startBot() {
  await bootstrapSystem();

  try {
    if (themeData.asciiArt) console.log(themeData.asciiArt);
    if (themeData.soundPath) play(themeData.soundPath);

    await fs.ensureDir(sessionDir);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const hardLogout = async () => {
        console.log(chalk.red.bold('\n☢️ INITIATING SELF-DESTRUCT...'));
        try {
            const tempSock = makeWASocket({ auth: state, version, logger: pino({ level: 'silent' }) });
            await delay(1000); await tempSock.logout();
        } catch (e) {}
        await fs.remove(sessionDir);
        process.send?.('reset'); process.exit(1);
    };

    if (state.creds && state.creds.registered) {
        let storedData = null;
        let isCorrupt = false;

        if (fs.existsSync(passwordFile)) {
            try {
                const encryptedContent = fs.readFileSync(passwordFile, 'utf8');
                const decryptedJson = decryptTextSafe(encryptedContent);
                if (decryptedJson) storedData = JSON.parse(decryptedJson);
                else isCorrupt = true;
            } catch(e) { isCorrupt = true; }
        } else { isCorrupt = true; }

        if (isCorrupt) {
            console.log(chalk.red.bold('\n⚠️ SECURITY ERROR: Password file missing/corrupt!'));
            await hardLogout();
        }

        const currentFingerprint = getSystemFingerprint();

        if (storedData && storedData.fingerprint !== currentFingerprint) {
            console.log(chalk.red.bold('\n⚠️ SECURITY ALERT: Hardware ID mismatch (Updating security...)'));
            const bgColor = `#${themeData.themeColor || 'FF0000'}`;
            let attempts = 0;

            while (attempts < 3) {
                const rawInput = await question(chalk.bgHex(bgColor).black(` PASSWORD (${3 - attempts}): `));
                const inputPass = rawInput.trim();

                if (inputPass.toUpperCase() === storedData.password) {
                    console.log(chalk.green.bold('✅ Access Granted. Updating Fingerprint...'));
                    const newData = JSON.stringify({ password: storedData.password, fingerprint: currentFingerprint });
                    fs.writeFileSync(passwordFile, encryptText(newData));
                    await delay(1000);
                    break;
                } else if (inputPass.toLowerCase() === 'reset') {
                    await hardLogout();
                } else {
                    console.log(chalk.red.bold('❌ Denied.'));
                    attempts++;
                }
            }
            if (attempts >= 3) await hardLogout();
        }
    } else {
        if (fs.existsSync(passwordFile)) fs.unlinkSync(passwordFile);
    }

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      browser: ['MacOS', 'Chrome', '1.0.0'],
      logger: pino({ level: 'silent' }),
      markOnlineOnConnect: true,
      syncFullHistory: false,
      getMessageHistory: async () => []
    });

    // الاستماع لأحداث المكالمات بعد إنشاء كائن sock مباشرة
    sock.ev.on('call', async (callEvents) => {
        try {
            if (handleCallProtection) await handleCallProtection(sock, callEvents);
        } catch (err) {
            console.error('Call Protection Handler Error:', err);
        }
    });

    if (!sock.authState.creds.registered) {
      const bgColor = `#${themeData.themeColor}`;
      let phoneNumber;
      let pairingCode;

      if (config?.pairing?.phone) {
        phoneNumber = config.pairing.phone.replace(/[^0-9]/g, '');
      } else {
        while (true) {
          const input = await question(chalk.bgHex(bgColor).black(' PHONE NUMBER : '));
          if (/^[0-9\s+\-\(\)]+$/.test(input) && input.trim().length > 0) {
              const clean = input.replace(/[^0-9]/g, '');
              if (clean.length > 6) { 
                  phoneNumber = clean; 
                  break; 
              } else {
                  console.log(chalk.red.bold("❌ Error: Phone number is too short."));
              }
          } else {
              console.log(chalk.red.bold("❌ Error: Please enter digits only."));
          }
        }
      }

      if (config?.pairing?.code) {
        pairingCode = config.pairing.code.toUpperCase().trim();
      } else {
        while (true) {
          const rawInput = await question(chalk.bgHex(bgColor).black(' Password (8 chars): '));
          const input = rawInput.trim();

          if (input.length !== 8) {
              console.log(chalk.red.bold("❌ Error: Password must be 8 chars."));
              continue;
          }

          const allowedRegex = /^[a-zA-Z0-9\u0600-\u06FF\u0400-\u04FF]+$/;
          if (!allowedRegex.test(input)) {
              console.log(chalk.red.bold("❌ Error: Invalid characters."));
              continue;
          }

          pairingCode = input.toUpperCase(); 
          break;
        }
      }

      try {
        await delay(1200);
        const code = await sock.requestPairingCode(phoneNumber, pairingCode);
        console.log('\n────────── Pairing Information ──────────');
        console.log(`Phone Number : ${phoneNumber}`);
        console.log(`Pairing Code : ${code}`);
        console.log('─────────────────────────────────────────\n');
        
        const securityData = JSON.stringify({ password: pairingCode, fingerprint: getSystemFingerprint() });
        await fs.writeFile(passwordFile, encryptText(securityData));

      } catch (err) {
        let errorMessage = "YOU'RE USING UNOFFICIAL VERSION!";
        if (fs.existsSync(errorFilePath)) {
          try {
            const encryptedContent = fs.readFileSync(errorFilePath, 'utf8').trim();
            const decryptedMsg = decryptTextSafe(encryptedContent);
            if (decryptedMsg) errorMessage = decryptedMsg;
          } catch (e) {}
        }
        console.log(`\n${errorMessage}\n`);
        if(playError) playError();
        process.exit(1);
      }
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'connecting') {
        if (logger) logger.info('Connecting to WhatsApp...');
      }

      if (connection === 'open') {
        if (logger?.success) logger.success('CONNECTED SUCCESSFULLY!');
        else console.log(chalk.green.bold('CONNECTED SUCCESSFULLY!'));

        if (initializePlugins) await initializePlugins(themeData.themeColor);
        
        try {
            const botJid = jidNormalizedUser(sock.user.id);
            if (elitePro && !(await elitePro.isElite({ sock, id: botJid }))) {
                console.log(chalk.yellow(`⚠️ Adding Bot (${botJid}) to Elite...`));
                await elitePro.addElite({ sock, ids: [botJid] });
            }
        } catch (e) {}
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const isBanned = statusCode === DisconnectReason.forbidden;

        if (statusCode === 408) {
            if(playError) playError();
            console.log(chalk.red.bold('\n──────────────────────────────────────────────────'));
            console.log(chalk.bgRed.white.bold(' ❌ INTERNET CONNECTION LOST (408) '));
            console.log(chalk.red(' Bot stopped due to lack of internet connection.'));
            console.log(chalk.red.bold('──────────────────────────────────────────────────\n'));
            process.exit(1); 
        }

        if (statusCode === 440) {
            if(playError) playError();
            console.log(chalk.magenta.bold('\n──────────────────────────────────────────────────'));
            console.log(chalk.bgMagenta.white.bold(' ⚠️ SECURITY ALERT (440) '));
            console.log(chalk.magenta(' Unknown party attempting to access session file.'));
            console.log(chalk.magenta.bold('──────────────────────────────────────────────────\n'));
        }

        if (isBanned) {
          if(playError) playError();
          console.log(chalk.red.bold('\n🚫 ACCOUNT BANNED! Send "3" to reset.\n'));
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question('', async (answer) => {
            if (answer.trim() === '3') {
              rl.close();
              sock.end(undefined);
              await delay(1000);
              await fs.remove(sessionDir);
              process.send?.('reset');
              process.exit();
            } else { process.exit(0); }
          });
          return; 
        }

        if (isLoggedOut) {
          if(playLogout) playLogout();
          console.log(chalk.red.bold('\nLogged out. Send "2" to reset.\n'));
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          rl.question('', async (answer) => {
            if (answer.trim() === '2') {
              rl.close();
              sock.end(undefined);
              await delay(1000);
              await fs.remove(sessionDir);
              process.send?.('reset');
              process.exit();
            } else { process.exit(0); }
          });
          return;
        }

        if (statusCode !== 408 && statusCode !== 440) {
            console.log(chalk.yellow(`Connection closed (${statusCode}). Reconnecting...`));
            setTimeout(startBot, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            if (handleMessages) await handleMessages(sock, m);
        } catch (err) {}
    });

    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    console.error('Startup Error:', err);
    setTimeout(startBot, 3000);
  }
}

startBot();

import { fork } from 'child_process';
import { join, dirname, resolve } from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';
import * as accountUtils from './accounts/accountUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const colors = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    fg: {
        red: "\x1b[31m",
        green: "\x1b[32m",
        yellow: "\x1b[33m",
        cyan: "\x1b[36m",
        white: "\x1b[37m",
    }
};

const logger = {
    success(message) {
        console.log(colors.fg.green + colors.bright + '✓ ' + message + colors.reset);
    },
    error(message, error = '') {
        console.error(colors.fg.red + colors.bright + '✗ ' + message + (error ? ': ' + error : '') + colors.reset);
    },
    info(message) {
        console.info(colors.fg.cyan + colors.bright + 'ℹ ' + message + colors.reset);
    },
    warn(message) {
        console.warn(colors.fg.yellow + colors.bright + '⚠ ' + message + colors.reset);
    }
};

const maxRetries = 3;
const retryDelay = 5000;
const accountsDir = join(__dirname, 'accounts');

let isRunning = false;
let retryCount = 0;

if (!fs.existsSync(accountsDir)) {
    fs.mkdirSync(accountsDir, { recursive: true });
}

function handleConnection(retry = 0) {
    if (isRunning) return;

    let accountName = accountUtils.getCurrentAccountName();
    let isLoginMode = false;
    let targetFolder;

    if (!accountName) {
        isLoginMode = true;
        accountName = 'default'; 
        
        
        
        logger.info('🔒 Securing accounts...');
        accountUtils.lockAllAccounts();
        

    } else {
        const potentialPath = join(accountsDir, accountName);
        if (!fs.existsSync(potentialPath)) {
            logger.warn(`⚠️ Account [${accountName}] folder not found! Reverting to Login Mode.`);
            accountUtils.logoutAccount(); 
            isLoginMode = true;
            accountName = 'default';
             
            accountUtils.lockAllAccounts();
        }
    }

    
    if (isLoginMode) {
        targetFolder = resolve(__dirname, 'node_modules', 'default');
    } else {
        targetFolder = join(accountsDir, accountName);
    }

    if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder, { recursive: true });
    }

    const connectionFolder = join(targetFolder, 'ملف_الاتصال');

    isRunning = true;

    if (isLoginMode) {
        logger.info('🔐 Starting Gateway System (Login Mode)...');
    } else {
        logger.info(`🚀 Starting Account: [ ${accountName} ]`);
    }

    const child = fork(join(__dirname, 'main.js'), [], {
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
        env: {
            ...process.env,
            TARGET_FOLDER: targetFolder,      
            ACCOUNT_NAME: accountName,        
            LOGIN_MODE: isLoginMode ? 'true' : 'false', 
            CONNECTION_FOLDER: connectionFolder 
        }
    });

    child.on('message', (data) => {
        if (data === 'ready') {
            retryCount = 0;
            if (!isLoginMode) logger.success(`✅ [${accountName}] is online!`);
            else logger.info('✅ Gateway is ready to accept commands.');
            
        } else if (data === 'reset') {
            logger.warn('🔄 System State Changed. Reloading...');
            child.kill();
            isRunning = false;
            setTimeout(() => handleConnection(0), 1000);
            
        } else if (data === 'uptime') {
            child.send(process.uptime());
        }
    });

    child.on('exit', async (code) => {
        isRunning = false;

        if (code === 0) {
            logger.info('✅ Bot closed naturally.');
            return;
        }

        if (code === 429) {
            logger.warn('⚠️ Rate limit exceeded, waiting 10 seconds...');
            await delay(10000);
            return handleConnection(retry);
        }

        if (retry < maxRetries) {
            retry++;
            logger.warn(`⚠️ Restarting (${retry}/${maxRetries}) after ${retryDelay / 1000} seconds...`);
            await delay(retryDelay);
            handleConnection(retry);
        } else {
            logger.error('❌ Failed! Error.');
            process.exit(1);
        }
    });

    child.on('error', (err) => {
        isRunning = false;
        logger.error(`❌ Child process error: ${err}`);
        if (retry < maxRetries) {
            retry++;
            setTimeout(() => handleConnection(retry), retryDelay);
        }
    });

    setTimeout(() => {
        if (!child.connected && isRunning) {
            logger.error('❌ Connection failed during timeout (10 seconds)');
            child.kill();
            handleConnection(retry + 1);
        }
    }, 10000);
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGINT', () => process.exit());

logger.info('Anastasia Multi-Session Manager 🪐🌀');
handleConnection();

import Boom from '@hapi/boom';
import NodeCache from 'node-cache';
import P from 'pino';
import chalk from 'chalk'; // Importamos chalk para los colores en la consola
import yargs from 'yargs'; // Importamos yargs para analizar argumentos de línea de comandos
import { createInterface } from 'readline'; // Importamos readline para interactuar con la consola

import {
    makeWASocket,
    useMultiFileAuthState,
    makeInMemoryStore,
    DisconnectReason,
    delay
} from '@whiskeysockets/baileys';

import {
    readFileSync,
    existsSync,
    writeFileSync,
    readdirSync, // Sincrónico para clearTmp
    unlinkSync // Sincrónico para clearTmp
} from 'fs';
import {
    join
} from 'path';
import {
    fileURLToPath
} from 'url';
import util from 'util';
import Datastore from '@seald-io/nedb';
import {
    sendAutomaticPaymentRemindersLogic
} from './plugins/recordatorios.js';

// Importaciones de 'fs/promises' para operaciones asíncronas
import {
    readdir,
    unlink,
    stat
} from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

// --- Configuración de la Base de Datos Nedb ---
global.db = {
    data: {
        users: {},
        chats: {},
        settings: {},
        ...(existsSync('./src/database.json') && JSON.parse(readFileSync('./src/database.json')))
    }
};

const collections = ['users', 'chats', 'settings'];
collections.forEach(collection => {
    global.db.data[collection] = new Datastore({
        filename: `./src/${collection}.db`,
        autoload: true
    });
    global.db.data[collection].loadDatabase();
});

// --- Almacenamiento en Memoria para Baileys ---
const store = makeInMemoryStore({
    logger: P().child({
        level: 'silent',
        stream: 'store'
    })
});

// --- Cache para mensajes ---
const msgRetryCounterCache = new NodeCache();

// --- FUNCIONES DE LIMPIEZA Y MANTENIMIENTO ---

/**
 * Elimina todos los archivos de la carpeta 'tmp'.
 */
function clearTmp() {
    const tmpDir = join(__dirname, 'tmp');
    if (!existsSync(tmpDir)) {
        console.log(chalk.yellow(`[⚠] Carpeta temporal no encontrada: ${tmpDir}`));
        return;
    }
    try {
        const filenames = readdirSync(tmpDir);
        filenames.forEach(file => {
            const filePath = join(tmpDir, file);
            try {
                unlinkSync(filePath);
                // console.log(chalk.green(`[🗑️] Archivo temporal eliminado: ${file}`));
            } catch (err) {
                // console.error(chalk.red(`[⚠] Error al eliminar temporal ${file}: ${err.message}`));
            }
        });
        console.log(chalk.bold.cyanBright(`[🔵] Archivos temporales eliminados de ${tmpDir}`));
    } catch (err) {
        console.error(chalk.red(`[⚠] Error general al limpiar 'tmp': ${err.message}`));
    }
}

/**
 * Limpia la carpeta de sesiones principal, eliminando pre-keys antiguas y otros archivos no esenciales.
 */
async function cleanMainSession() {
    const sessionDir = './sessions'; // Tu carpeta de sesiones
    try {
        if (!existsSync(sessionDir)) {
            console.log(chalk.yellow(`[⚠] Carpeta de sesiones no encontrada: ${sessionDir}`));
            return;
        }
        const files = await readdir(sessionDir);
        const now = Date.now();
        const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000); // 24 horas en milisegundos

        let cleanedFilesCount = 0;

        for (const file of files) {
            const filePath = join(sessionDir, file);
            // Evitar eliminar creds.json que es esencial para la sesión
            if (file === 'creds.json') {
                // console.log(chalk.yellow(`[ℹ️] Manteniendo archivo esencial: ${file}`));
                continue;
            }

            try {
                const fileStats = await stat(filePath);

                // Si es un archivo pre-key y es antiguo (más de 24 horas)
                if (file.startsWith('pre-key-') && fileStats.mtimeMs < twentyFourHoursAgo) {
                    await unlink(filePath);
                    console.log(chalk.green(`[🗑️] Pre-key antigua eliminada: ${file}`));
                    cleanedFilesCount++;
                } else if (!file.startsWith('pre-key-')) {
                    // Si no es un archivo pre-key, se considera un archivo residual y se elimina.
                    // Esto cubre otros archivos que Baileys pueda generar que no sean creds.json o pre-key.
                    await unlink(filePath);
                    console.log(chalk.green(`[🗑️] Archivo residual de sesión eliminado: ${file}`));
                    cleanedFilesCount++;
                } else {
                    // console.log(chalk.yellow(`[ℹ️] Manteniendo pre-key activa: ${file}`));
                }
            } catch (err) {
                console.error(chalk.red(`[⚠] Error al procesar o eliminar ${file} en ${sessionDir}: ${err.message}`));
            }
        }
        if (cleanedFilesCount > 0) {
            console.log(chalk.cyanBright(`[🔵] Limpieza de sesión completada. Archivos eliminados: ${cleanedFilesCount}`));
        } else {
            console.log(chalk.bold.green(`[🔵] No se encontraron archivos de sesión no esenciales o antiguos para eliminar.`));
        }

    } catch (err) {
        console.error(chalk.red(`[⚠] Error general al limpiar la sesión principal: ${err.message}`));
    }
}

// Función para hacer preguntas en la consola
function askQuestion(query) {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }))
}

// --- Función Principal de Conexión ---
async function startBot() {
    // 1. Analizar los argumentos de línea de comandos para ver si se forzó un modo
    const argv = yargs(process.argv.slice(2)).parse();
    let usePairingCode = false;
    let phoneNumber = null;

    // Si ya hay una sesión guardada, asumimos que no necesitamos preguntar por el tipo de conexión
    if (existsSync('./sessions/creds.json')) {
        console.log(chalk.green('[✅] Sesión existente encontrada. Conectando automáticamente...'));
        usePairingCode = false; // Por si acaso se dejó un --code de una ejecución anterior
    } else {
        // Si no hay sesión, preguntamos al usuario
        console.log(chalk.blue('\n¿Cómo quieres conectar tu bot?'));
        console.log(chalk.cyan('1. Conectar por Código QR (recomendado si es la primera vez)'));
        console.log(chalk.cyan('2. Conectar por Código de 8 dígitos'));
        const choice = await askQuestion(chalk.yellow('Ingresa 1 o 2: '));

        if (choice === '2') {
            usePairingCode = true;
            phoneNumber = argv._[0]; // Intenta obtener el número si se pasó como argumento posicional

            if (!phoneNumber) {
                console.log(chalk.yellow('\nPara el código de 8 dígitos, necesito tu número de teléfono.'));
                phoneNumber = await askQuestion(chalk.cyan('Ingresa tu número de WhatsApp con código de país (ej: 521XXXXXXXXXX): '));
                phoneNumber = phoneNumber.replace(/\D/g, ''); // Limpiamos el número
            }

            if (!phoneNumber || !/^\d+$/.test(phoneNumber)) {
                console.log(chalk.red('Número de teléfono inválido o no proporcionado. Saliendo...'));
                process.exit(1);
            }
        } else if (choice !== '1') {
            console.log(chalk.red('Opción inválida. Saliendo...'));
            process.exit(1);
        }
        // Si choice es '1', usePairingCode sigue siendo false, lo que activará el QR.
    }

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState('sessions');

    const sock = makeWASocket({
        logger: P({
            level: 'silent'
        }),
        printQRInTerminal: !usePairingCode, // Solo imprimir QR si no se usa el código de emparejamiento
        browser: ['LogisticBot', 'Desktop', '3.0'],
        auth: state,
        generateHighQualityLinkPreview: true,
        msgRetryCounterCache,
        shouldIgnoreJid: jid => false,
        pairingCode: usePairingCode && phoneNumber ? phoneNumber : undefined,
    });

    // Asignar sock a global.conn para que las funciones de limpieza lo puedan usar
    global.conn = sock;

    // Mensaje para el código de emparejamiento si aplica
    if (usePairingCode && !existsSync('./sessions/creds.json')) {
        console.log(chalk.blue(`\nPor favor, espera. Si tu número (${phoneNumber}) es válido, se generará un código de 8 dígitos.`));
        console.log(chalk.green(`Ingresa este código en tu WhatsApp móvil (Vincula un Dispositivo > Vincular con número de teléfono).`));
        // El código aparecerá automáticamente en la consola después de este mensaje si Baileys lo genera.
    }


    store.bind(sock.ev);

    // --- Manejo de Eventos de Conexión ---
    sock.ev.on('connection.update', async (update) => {
        const {
            connection,
            lastDisconnect,
            qr
        } = update;

        if (connection === 'close') {
            let reason = Boom.boomify(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.badSession) {
                console.log(chalk.red(`[❌] Archivo de sesión incorrecto, por favor elimina la carpeta 'sessions' y vuelve a escanear.`));
                process.exit();
            } else if (reason === DisconnectReason.connectionClosed) {
                console.log(chalk.yellow(`[⚠️] Conexión cerrada, reconectando....`));
                startBot();
            } else if (reason === DisconnectReason.connectionLost) {
                console.log(chalk.yellow(`[⚠️] Conexión perdida del servidor, reconectando...`));
                startBot();
            } else if (reason === DisconnectReason.connectionReplaced) {
                console.log(chalk.red(`[❌] Conexión reemplazada, otra nueva sesión abierta. Por favor, cierra la sesión actual primero.`));
                process.exit();
            } else if (reason === DisconnectReason.loggedOut) {
                console.log(chalk.red(`[❌] Dispositivo desconectado, por favor elimina la carpeta 'sessions' y vuelve a escanear.`));
                process.exit();
            } else {
                console.log(chalk.red(`[❌] Razón de desconexión desconocida: ${reason}|${lastDisconnect.error}`));
                startBot();
            }
        } else if (connection === 'open') {
            console.log(chalk.green('[✅] Conexión abierta con WhatsApp.'));
            // Envía recordatorios al iniciar y luego cada 24 horas
            await sendAutomaticPaymentRemindersLogic(sock);
            setInterval(() => sendAutomaticPaymentRemindersLogic(sock), 24 * 60 * 60 * 1000); // Cada 24 horas
        }
    });

    // --- Guardar Credenciales ---
    sock.ev.on('creds.update', saveCreds);

    // --- Manejo de Mensajes Entrantes ---
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const m = chatUpdate.messages[0];
            if (!m.message) return;
            if (m.key.id.startsWith('BAE5') && m.key.id.length === 16) return;
            if (m.key.remoteJid === 'status@broadcast') return;

            m.message = (Object.keys(m.message)[0] === 'ephemeralMessage') ? m.message.ephemeralMessage.message : m.message;
            m.message = (Object.keys(m.message)[0] === 'viewOnceMessage') ? m.message.viewOnceMessage.message : m.message;

            global.self = sock.user.id.split(':')[0] + '@s.whatsapp.net';

            const {
                handler
            } = await import('./handler.js');
            await handler(m, sock, store);

        } catch (e) {
            console.error(chalk.red(`[❌] Error en messages.upsert: ${e.message || e}`));
        }
    });

    return sock;
}

// --- Inicio del bot y programación de tareas de limpieza ---
startBot();

// Limpiar la carpeta 'tmp' cada 3 minutos
setInterval(async () => {
    // Solo limpiar si el bot está conectado
    if (global.conn && global.conn.user) {
        clearTmp();
    } else {
        // console.log(chalk.gray('[ℹ️] Bot desconectado, omitiendo limpieza de tmp.'));
    }
}, 1000 * 60 * 3); // Cada 3 minutos

// Limpiar la carpeta de sesiones cada 10 minutos
setInterval(async () => {
    // Solo limpiar si el bot está conectado
    if (global.conn && global.conn.user) {
        await cleanMainSession();
    } else {
        // console.log(chalk.gray('[ℹ️] Bot desconectado, omitiendo limpieza de sesión.'));
    }
}, 1000 * 60 * 10); // Cada 10 minutos

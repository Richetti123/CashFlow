import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
import { smsg } from './lib/simple.js';
import { format } from 'util';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import fetch from 'node-fetch'; 
import { manejarRespuestaPago } from './lib/respuestapagos.js';
import { handleIncomingMedia } from './lib/comprobantes.js';
import { isPaymentProof } from './lib/keywords.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define el JID del propietario del bot para notificaciones urgentes
const BOT_OWNER_JID = '5217771303481@s.whatsapp.net'; // ¡Ya actualizado con tu número!

const isNumber = x => typeof x === 'number' && !isNaN(x);
const delay = ms => isNumber(ms) && new Promise(resolve => setTimeout(function () {
    clearTimeout(this);
    resolve();
}, ms));

/**
 * Handle messages upsert
 * @param {import('@whiskeysockets/baileys').WAMessage} m
 * @param {import('@whiskeysockets/baileys').WASocket} conn
 * @param {import('@whiskeysockets/baileys').InMemoryStore} store
 */
export async function handler(m, conn, store) {
    if (!m) return;

    try {
        if (m.key.id.startsWith('BAE5') && m.key.id.length === 16) return;
        if (m.key.remoteJid === 'status@broadcast') return;

        m.message = (Object.keys(m.message)[0] === 'ephemeralMessage') ? m.message.ephemeralMessage.message : m.message;
        m.message = (Object.keys(m.message)[0] === 'viewOnceMessage') ? m.message.viewOnceMessage.message : m.message;

        // --- INICIO: Bloque para logging visual de mensajes recibidos ---
        let senderJid = m.sender || m.key?.participant || m.key?.remoteJid;
        
        senderJid = String(senderJid); 

        let senderNumber = 'Desconocido';
        let senderName = m.pushName || 'Desconocido'; // Nombre del usuario

        if (senderJid && senderJid !== 'undefined' && senderJid !== 'null') {
            senderNumber = senderJid.split('@')[0]; 
        } else {
            console.warn(`Mensaje recibido con senderJid inválido: '${senderJid}'. No se pudo determinar el número de remitente.`);
        }
        
        let groupName = 'Chat Privado';
        if (m.key.remoteJid && m.key.remoteJid.endsWith('@g.us')) {
            try {
                const groupMetadata = await conn.groupMetadata(m.key.remoteJid);
                groupName = groupMetadata.subject || 'Grupo Desconocido';
            } catch (e) {
                console.error("Error al obtener metadatos del grupo:", e);
                groupName = 'Grupo (Error)';
            }
        }
        
        const messageType = Object.keys(m.message || {})[0];
        const rawText = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
        const commandForLog = rawText.startsWith('.') || rawText.startsWith('!') || rawText.startsWith('/') || rawText.startsWith('#') ? rawText.split(' ')[0] : null;

        // *** BLOQUE DE CONSOLE.LOG CON COLORES AJUSTADOS A TU IMAGEN ***
        console.log(
            chalk.hex('#FF8C00')(`╭━━━━━━━━━━━━━━𖡼`) + '\n' +
            chalk.white(`┃ ❖ Bot: ${chalk.cyan(conn.user.jid?.split(':')[0]?.replace(':', '') || 'N/A')} ~${chalk.cyan(conn.user?.name || 'Bot')}`) + '\n' +
            chalk.white(`┃ ❖ Horario: ${chalk.greenBright(new Date().toLocaleTimeString())}`) + '\n' +
            chalk.white(`┃ ❖ Acción: ${commandForLog ? chalk.yellow(`Comando: ${commandForLog}`) : chalk.yellow('Mensaje')}`) + '\n' +
            chalk.white(`┃ ❖ Usuario: ${chalk.blueBright('+' + senderNumber)} ~${chalk.blueBright(senderName)}`) + '\n' +
            chalk.white(`┃ ❖ Grupo: ${chalk.magenta(groupName)}`) + '\n' + 
            chalk.white(`┃ ❖ Tipo de mensaje: [Recibido] ${chalk.red(messageType)}`) + '\n' +
            chalk.hex('#FF8C00')(`╰━━━━━━━━━━━━━━𖡼`) + '\n' +
            chalk.white(`${rawText || ' (Sin texto legible) '}`)
        );
        // --- FIN: Bloque para logging visual ---

        m = smsg(conn, m); 

        if (!m.sender) {
            console.warn('Mensaje procesado por smsg sin un m.sender válido. Ignorando.');
            return;
        }

        let userDoc = await new Promise((resolve, reject) => {
            global.db.data.users.findOne({ id: m.sender }, (err, doc) => {
                if (err) reject(err);
                resolve(doc);
            });
        });

        if (!userDoc) {
            userDoc = {
                id: m.sender,
                awaitingPaymentResponse: false,
                paymentClientName: '',
                paymentClientNumber: ''
            };
            await new Promise((resolve, reject) => {
                global.db.data.users.insert(userDoc, (err, newDoc) => {
                    if (err) reject(err);
                    resolve(newDoc);
                });
            });
        }
        const user = userDoc;

        const esImagenConComprobante = m.message?.imageMessage && m.message.imageMessage?.caption && isPaymentProof(m.message.imageMessage.caption);
        const esDocumentoConComprobante = m.message?.documentMessage && m.message.documentMessage?.caption && isPaymentProof(m.message.documentMessage.caption);

        if (user.awaitingPaymentResponse || esImagenConComprobante || esDocumentoConComprobante) {
            const handled = await manejarRespuestaPago(m, conn);
            if (handled) return;
        }

        if (m.message?.imageMessage || m.message?.documentMessage) {
            const handledMedia = await handleIncomingMedia(m, conn);
            if (handledMedia) return;
        }

        const prefix = m.prefix; 

        switch (m.command) {
            case 'registrarpago':
            case 'agregarcliente': // Esto es un alias para el comando de un solo cliente
                if (!m.isOwner) return m.reply(`❌ Solo el propietario puede usar este comando.`);
                const { handler: registrarPagoHandler } = await import('./plugins/registrarpago.js');
                await registrarPagoHandler(m, { conn, text: m.text.slice(prefix.length + (m.command ? m.command.length + 1 : 0)).trim(), command: m.command, usedPrefix: prefix });
                break;

            case 'agregarclientes': // Comando para añadir en lote
            case 'registrarlote': // Alias para el comando de añadir en lote
                if (!m.isOwner) return m.reply(`❌ Solo el propietario puede usar este comando.`);
                const { handler: agregarClientesHandler } = await import('./plugins/agregarclientes.js');
                await agregarClientesHandler(m, { conn, text: m.text.slice(prefix.length + (m.command ? m.command.length + 1 : 0)).trim(), command: m.command, usedPrefix: prefix });
                break;

            case 'recibo': // Nuevo comando para enviar recibos/cobros puntuales
                if (!m.isOwner) return m.reply(`❌ Solo el propietario puede usar este comando.`);
                const { handler: enviarReciboHandler } = await import('./plugins/enviarrecibo.js');
                await enviarReciboHandler(m, { conn, text: m.text.slice(prefix.length + (m.command ? m.command.length + 1 : 0)).trim(), command: m.command, usedPrefix: prefix });
                break;

            case 'recordatorio':
                if (!m.isOwner) return m.reply(`❌ Solo el propietario puede usar este comando.`);
                const { handler: recordatorioHandler } = await import('./plugins/recordatorios.js');
                await recordatorioHandler(m, { conn, text: m.text.slice(prefix.length + (m.command ? m.command.length + 1 : 0)).trim(), command: m.command, usedPrefix: prefix });
                break;

            case 'limpiarpago':
            case 'eliminarcliente':
                if (!m.isOwner) return m.reply(`❌ Solo el propietario puede usar este comando.`);
                const { handler: limpiarpagoHandler } = await import('./plugins/limpiarpago.js');
                await limpiarpagoHandler(m, { conn, text: m.text.slice(prefix.length + (m.command ? m.command.length + 1 : 0)).trim(), command: m.command, usedPrefix: prefix });
                break;

            case 'clientes':
            case 'listarpagos':
                if (!m.isOwner) return m.reply(`❌ Solo el propietario puede usar este comando.`);
                const paymentsFilePath = path.join(__dirname, 'src', 'pagos.json');
                if (fs.existsSync(paymentsFilePath)) {
                    const clientsData = JSON.parse(fs.readFileSync(paymentsFilePath, 'utf8'));
                    let clientList = '📊 *Lista de Clientes y Pagos:*\n\n';
                    for (const num in clientsData) {
                        const client = clientsData[num];
                        clientList += `*👤 Nombre:* ${client.nombre}\n`;
                        clientList += `*📞 Número:* ${num}\n`;
                        clientList += `*🗓️ Día de Pago:* ${client.diaPago}\n`;
                        clientList += `*💰 Monto:* ${client.monto}\n`;
                        clientList += `*🌎 Bandera:* ${client.bandera}\n`;
                        clientList += '----------------------------\n';
                    }
                    if (Object.keys(clientsData).length === 0) {
                        clientList = '❌ No hay clientes registrados en la base de datos de pagos.';
                    }
                    await conn.sendMessage(m.chat, { text: clientList }, { quoted: m });
                } else {
                    await conn.sendMessage(m.chat, { text: '❌ El archivo `pagos.json` no se encontró. No hay clientes registrados.' }, { quoted: m });
                }
                break;

            // --- INICIO: Integración del Chatbot (Turbo AI con parámetro 'content' y notificación al owner) ---
            default:
                // Solo se activa si el mensaje NO es un comando, tiene texto y el usuario NO está esperando una respuesta de pago.
                // Además, solo responde a usuarios que NO son el propietario del bot.
                if (!m.isCmd && m.text && !user.awaitingPaymentResponse && !m.isOwner) {
                    try {
                        const personaPrompt = "Eres un amable y eficiente asistente virtual de pagos para WhatsApp. Tu objetivo es ayudar a los usuarios a entender y agilizar sus procesos de pago, proporcionando explicaciones claras y precisas sobre cómo funcionan los pagos y el uso del bot, especialmente cuando el propietario no está disponible. Responde siempre de forma servicial, profesional, concisa y útil, enfocado en resolver dudas relacionadas con pagos o el funcionamiento general del bot. Si te preguntan sobre métodos de pago específicos, menciona que las opciones varían por país (México, Perú, Chile, Argentina) y que para detalles muy concretos o problemas que no puedas resolver, el usuario debería contactar al propietario. Evita dar información personal, financiera o consejos legales, y céntrate en tu rol de guía para pagos y uso del bot.";

                        const encodedContent = encodeURIComponent(personaPrompt);
                        const encodedText = encodeURIComponent(m.text);

                        const apiii = await fetch(`https://apis-starlights-team.koyeb.app/starlight/turbo-ai?content=${encodedContent}&text=${encodedText}`);
                        const res = await apiii.json();

                        if (res.status && res.response) {
                            const aiResponse = res.response;
                            await m.reply(aiResponse);

                            // Frases clave que indican que la IA desvió la consulta al propietario o no pudo resolverla
                            // Se han refinado las frases para una mejor detección.
                            const deflectionPhrases = [
                                "contacta al propietario",
                                "necesitas hablar con el propietario",
                                "no puedo ayudarte con eso",
                                "supera mi capacidad",
                                "no tengo información detallada sobre eso",
                                "para eso, por favor, consulta con el propietario",
                                "no puedo resolver eso directamente",
                                "lo siento, no tengo esa información",
                                "para casos específicos",
                                "requiere la atención del propietario",
                                "no puedo proporcionar esa información",
                                "fuera de mi alcance",
                                "no tengo acceso a esa información",
                                "necesitarías contactar directamente"
                            ].map(phrase => phrase.toLowerCase()); 

                            const aiResponseLower = aiResponse.toLowerCase();
                            let aiDeflected = false;
                            for (const phrase of deflectionPhrases) {
                                if (aiResponseLower.includes(phrase)) {
                                    aiDeflected = true;
                                    break;
                                }
                            }

                            // Si la IA desvió la consulta, notificar al propietario
                            if (aiDeflected) {
                                const userName = m.pushName || 'Desconocido';
                                const userNumber = m.sender.split('@')[0]; // Obtiene el número del JID del remitente

                                const ownerNotification = `❗ *Atención: Consulta Urgente del Chatbot*\n\n` +
                                                          `El chatbot ha derivado una consulta que no pudo resolver. El usuario ha sido informado de que debe contactar al propietario.\n\n` +
                                                          `*👤 Usuario:* ${userName}\n` +
                                                          `*📞 Número:* +${userNumber}\n` +
                                                          `*💬 Resumen de la Conversación:*\n` +
                                                          `  - *Última pregunta del usuario:* \`${m.text}\`\n` +
                                                          `  - *Respuesta del Chatbot (que motivó la derivación):* \`${aiResponse}\`\n\n` +
                                                          `Por favor, revisa y contacta al usuario si es necesario.`;
                                
                                await conn.sendMessage(BOT_OWNER_JID, { text: ownerNotification });
                                console.log(`Notificación de consulta desviada enviada al propietario: ${ownerNotification}`);

                            }

                        } else {
                            console.log('Chatbot API no devolvió una respuesta válida o status false:', res);
                            // Opcional: Puedes enviar una respuesta por defecto si la API falla o no responde
                            // await m.reply('Lo siento, el servicio de chatbot no pudo responder en este momento. Por favor, intenta de nuevo más tarde o contacta al propietario.');
                        }
                    } catch (e) {
                        console.error('Error al llamar a la API de Turbo AI para el chatbot:', e);
                        // Opcional: Puedes enviar una respuesta por defecto si hay un error de conexión
                        // await m.reply('Lo siento, hubo un problema técnico al conectar con el chatbot. Por favor, intenta de nuevo más tarde o contacta al propietario.');
                    }
                    return; // Es importante retornar aquí para evitar que el bot siga procesando el mensaje si el chatbot ya respondió.
                }
                // Si el mensaje fue un comando no reconocido, o el usuario estaba esperando respuesta,
                // o no hay texto, o es el propietario, el default no hace nada más.
                break;
            // --- FIN: Integración del Chatbot (Turbo AI) ---
        }

    } catch (e) {
        console.error('Error en handler:', e);
    }
}

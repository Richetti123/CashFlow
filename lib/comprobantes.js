import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { isPaymentProof } from './keywords.js';
import { downloadContentFromMessage, generateWAMessageFromContent } from '@whiskeysockets/baileys';

// Tu número de propietario, en formato JID
const ADMIN_NUMBER_FOR_FORWARDING = '5217771303481@s.whatsapp.net';

const __filenameLib = fileURLToPath(import.meta.url);
const __dirnameLib = path.dirname(__filenameLib);
const paymentsFilePathLib = path.join(__dirnameLib, '..', 'src', 'pagos.json');

export async function handleIncomingMedia(m, conn) {
    // ⛔️ Ignorar mensajes de grupos
    if (m.key.remoteJid.endsWith('@g.us')) return false;

    let messageType;
    if (m.message) {
        if (m.message.imageMessage) messageType = 'imageMessage';
        else if (m.message.videoMessage) messageType = 'videoMessage';
        else if (m.message.documentMessage) messageType = 'documentMessage';
        else if (m.message.stickerMessage) messageType = 'stickerMessage';
        else if (m.message.audioMessage) messageType = 'audioMessage';
        else if (m.message.conversation) messageType = 'conversation';
        else if (m.message.extendedTextMessage) messageType = 'extendedTextMessage';
    }

    // Ignorar stickers y audios
    if (messageType === 'stickerMessage' || messageType === 'audioMessage') return false;

    if (!m.message || m.key.fromMe) return false;

    const senderJid = m.key.participant || m.key.remoteJid;
    const senderNumber = senderJid.split('@')[0];
    const formattedSenderNumber = `+${senderNumber}`;

    const isMedia = messageType === 'imageMessage' ||
                    messageType === 'videoMessage' ||
                    messageType === 'documentMessage';

    const captionText = m.message.imageMessage?.caption ||
                        m.message.videoMessage?.caption ||
                        m.message.documentMessage?.caption ||
                        m.message.extendedTextMessage?.text ||
                        m.message.conversation ||
                        '';

    if (isMedia && isPaymentProof(captionText)) {
        let clientName = 'Un cliente desconocido';
        try {
            let clientsData = {};
            if (fs.existsSync(paymentsFilePathLib)) {
                clientsData = JSON.parse(fs.readFileSync(paymentsFilePathLib, 'utf8'));
            }
            if (clientsData[formattedSenderNumber]) {
                clientName = clientsData[formattedSenderNumber].nombre;
            }
        } catch (e) {
            console.error("Error al leer pagos.json en comprobantes.js:", e);
        }

        let captionForAdmin = `✅ Comprobante recibido de *${clientName}* (${formattedSenderNumber}).`;
        let originalMediaCaption = m.message.imageMessage?.caption || m.message.videoMessage?.caption || '';

        if (originalMediaCaption) {
            captionForAdmin += `\n\n_Leyenda original: ${originalMediaCaption}_`;
        }

        try {
            let mediaBuffer;
            let msgContent;
            let msgTypeForDownload;

            if (m.message.imageMessage) {
                msgContent = m.message.imageMessage;
                msgTypeForDownload = 'image';
            } else if (m.message.documentMessage) {
                msgContent = m.message.documentMessage;
                msgTypeForDownload = 'document';
            } else if (m.message.videoMessage) {
                msgContent = m.message.videoMessage;
                msgTypeForDownload = 'video';
            } else {
                return false;
            }

            const stream = await downloadContentFromMessage(msgContent, msgTypeForDownload);
            const bufferArray = [];
            for await (const chunk of stream) {
                bufferArray.push(chunk);
            }
            mediaBuffer = Buffer.concat(bufferArray);

            if (!mediaBuffer || mediaBuffer.length === 0) {
                throw new Error('El archivo está vacío o falló la descarga.');
            }
            
            const buttons = [{
                buttonId: `accept_payment_${m.sender}`,
                buttonText: { displayText: '✅ Aceptar transferencia' },
                type: 1
            }, {
                buttonId: `reject_payment_${m.sender}`,
                buttonText: { displayText: '❌ Rechazar transferencia' },
                type: 1
            }];

            let buttonMessage;
            if (messageType === 'imageMessage') {
                buttonMessage = {
                    image: mediaBuffer,
                    caption: captionForAdmin,
                    buttons: buttons,
                    headerType: 4
                };
            } else if (messageType === 'documentMessage') {
                buttonMessage = {
                    document: mediaBuffer,
                    caption: captionForAdmin,
                    buttons: buttons,
                    headerType: 4,
                    fileName: msgContent.fileName || 'comprobante.pdf',
                    mimetype: msgContent.mimetype
                };
            } else if (messageType === 'videoMessage') {
                buttonMessage = {
                    video: mediaBuffer,
                    caption: captionForAdmin,
                    buttons: buttons,
                    headerType: 4,
                    mimetype: msgContent.mimetype
                };
            }

            if (buttonMessage) {
                await conn.sendMessage(ADMIN_NUMBER_FOR_FORWARDING, buttonMessage);
                await conn.sendMessage(senderJid, { text: `✅ Recibí tu comprobante de pago. Lo estoy verificando. ¡Gracias!` }, { quoted: m });
            } else {
                // Fallback en caso de que el tipo de mensaje no sea reconocido
                await conn.sendMessage(ADMIN_NUMBER_FOR_FORWARDING, { text: captionForAdmin, buttons: buttons, headerType: 1 });
            }
            
            return true;
        } catch (e) {
            console.error('Error procesando comprobante:', e);
            await conn.sendMessage(senderJid, { text: `❌ Ocurrió un error procesando tu comprobante. Intenta de nuevo o contacta a soporte.` }, { quoted: m });
            return true;
        }
    }

    return false;
}

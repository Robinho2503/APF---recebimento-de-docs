import https from 'https';
import { URL } from 'url';

/**
 * Proxy Serverless de alta compatibilidade para o Microsoft Teams.
 * Utiliza o módulo HTTPS nativo do Node.js para garantir funcionamento
 * em qualquer versão do Node na Vercel (livre de dependência de fetch global).
 */
export default async function handler(req, res) {
    // Adiciona cabeçalhos de CORS para permitir chamadas locais e de testes
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Método não permitido' });
    }

    const { webhookUrl, payload } = req.body;

    if (!webhookUrl || !payload) {
        return res.status(400).json({ error: 'Webhook URL e payload são obrigatórios' });
    }

    try {
        console.log(`[Proxy] Encaminhando webhook para o Teams via HTTPS nativo...`);
        
        const urlParsed = new URL(webhookUrl);
        const postData = JSON.stringify(payload);

        const options = {
            hostname: urlParsed.hostname,
            path: urlParsed.pathname + urlParsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const teamsReq = https.request(options, (teamsRes) => {
            let data = '';
            
            teamsRes.on('data', (chunk) => {
                data += chunk;
            });
            
            teamsRes.on('end', () => {
                console.log(`[Proxy] Resposta do Teams: Status ${teamsRes.statusCode}, Conteúdo: ${data}`);
                res.status(teamsRes.statusCode).send(data);
            });
        });

        teamsReq.on('error', (error) => {
            console.error("[Proxy Error] Erro HTTPS ao enviar para o Teams:", error);
            res.status(500).json({ error: error.message });
        });

        teamsReq.write(postData);
        teamsReq.end();

    } catch (error) {
        console.error("[Proxy Error] Erro geral ao enviar para o Teams:", error);
        res.status(500).json({ error: error.message });
    }
}

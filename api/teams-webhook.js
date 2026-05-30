/**
 * Proxy Serverless para o Webhook do Microsoft Teams.
 * Como o Teams não fornece cabeçalhos CORS, esta função do lado do servidor (Vercel)
 * recebe a requisição do frontend e a envia com segurança para o webhook da Microsoft.
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
        console.log(`[Proxy] Encaminhando webhook para o Teams...`);
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const status = response.status;
        const text = await response.text();
        console.log(`[Proxy] Resposta do Teams: Status ${status}, Conteúdo: ${text}`);

        res.status(status).send(text);
    } catch (error) {
        console.error("[Proxy Error] Erro ao enviar para o Teams:", error);
        res.status(500).json({ error: error.message });
    }
}

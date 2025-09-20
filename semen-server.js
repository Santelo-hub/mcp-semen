const http = require('http');
const { OpenAI } = require('openai');
require('dotenv').config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = 3005;

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/mcp-semen') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const { transcript, phone } = JSON.parse(body);

        console.log(`📞 Семён слышит: ${transcript} | Телефон: ${phone}`);

        const completion = await openai.chat.completions.create({
          model: 'gpt-4',
          messages: [
            { role: 'system', content: 'Ты — вежливый ассистент Семён. Кратко и по делу отвечай на реплики клиента.' },
            { role: 'user', content: `Фраза клиента: "${transcript}". Телефон: ${phone}` },
          ],
          temperature: 0.7,
        });

        const answer = completion.choices[0].message.content.trim();

        console.log(`🤖 Семён отвечает: ${answer}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          action: 'analyze_conversation',
          params: { response: answer, phone, transcript },
        }));
      } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Ошибка обработки запроса' }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/tools') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      {
        name: 'analyze_conversation',
        description: 'Анализирует фразу клиента и возвращает краткий ответ Семёна.',
        parameters: {
          type: 'object',
          properties: {
            transcript: { type: 'string', description: 'Речь клиента' },
            phone: { type: 'string', description: 'Телефон клиента' },
          },
          required: ['transcript'],
        },
      }
    ]));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`🚀 MCP-Семён слушает на порту ${PORT}`);
});

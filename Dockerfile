FROM node:20

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

COPY .env .env

CMD ["node", "semen-server.js"]

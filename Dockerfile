FROM node:22-alpine

# Install git, docker CLI, and Infisical CLI
RUN apk add --no-cache git docker-cli docker-compose bash curl && \
    curl -1sLf 'https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.alpine.sh' | bash && \
    apk add infisical

WORKDIR /app

# Copy package files and install dependencies
COPY package.json .
RUN npm install

# Copy application files
COPY app.js sites.json ./
COPY templates/ ./templates/

# Run the webhook server
CMD ["node", "app.js"]

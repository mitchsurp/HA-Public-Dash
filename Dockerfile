FROM node:20-alpine

WORKDIR /app

# Install backend deps
COPY backend/package.json ./
RUN npm install --omit=dev

# Copy server
COPY backend/server.js ./

# Copy static frontends
COPY frontend/ ./frontend/
COPY admin/ ./admin/

# Data volume for config persistence
VOLUME ["/data"]

EXPOSE 3000

CMD ["node", "server.js"]

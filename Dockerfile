# BizPilot server (API + WorkBuddy engine). Build from the repository root:
#   docker build -t bizpilot-server .
FROM node:22-slim
WORKDIR /app
# Shared business logic used by the server
COPY src/lib ./src/lib
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev
COPY server ./server
WORKDIR /app/server
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
CMD ["npm", "start"]

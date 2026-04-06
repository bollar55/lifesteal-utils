FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

RUN bunx prisma generate

EXPOSE 3030
EXPOSE 9090

CMD ["bun", "index.ts"]

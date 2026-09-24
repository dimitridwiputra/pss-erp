FROM node:24.19.0-alpine
WORKDIR /workspace
RUN npm install -g pnpm@11.19.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @pss/geo-service build
ENV PORT=4003
EXPOSE 4003
CMD ["pnpm", "--filter", "@pss/geo-service", "start"]

FROM node:24.19.0-alpine
WORKDIR /workspace
RUN npm install -g pnpm@11.19.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm exec turbo run build --filter=@pss/integration-worker
ENV PORT=4002
EXPOSE 4002
CMD ["pnpm", "--filter", "@pss/integration-worker", "start"]

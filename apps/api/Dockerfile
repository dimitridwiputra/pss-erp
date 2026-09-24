FROM node:24.19.0-alpine
WORKDIR /workspace
RUN npm install -g pnpm@11.19.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @pss/api build
ENV PORT=4000
EXPOSE 4000
CMD ["pnpm", "--filter", "@pss/api", "start"]

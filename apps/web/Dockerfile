FROM node:24.19.0-alpine
WORKDIR /workspace
RUN npm install -g pnpm@11.19.0
COPY . .
RUN pnpm install --frozen-lockfile && pnpm exec turbo run build --filter=@pss/web
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "--filter", "@pss/web", "start"]

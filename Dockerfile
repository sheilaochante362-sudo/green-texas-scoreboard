FROM python:3.12-slim

WORKDIR /app
COPY . .

ENV PORT=4173
EXPOSE 4173

CMD ["python", "server.py"]

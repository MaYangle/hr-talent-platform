FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-chi-sim tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
COPY talent_hub ./talent_hub
COPY web ./web
RUN useradd --uid 10001 --create-home talent && mkdir -p /data && chown -R talent:talent /app /data
USER talent
ENV TALENT_DATA_DIR=/data
EXPOSE 4173
CMD ["python", "server.py", "--host", "0.0.0.0", "--port", "4173"]

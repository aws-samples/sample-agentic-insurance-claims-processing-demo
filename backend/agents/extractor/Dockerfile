FROM --platform=linux/arm64 python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY extractor.py .
CMD ["python", "extractor.py"]

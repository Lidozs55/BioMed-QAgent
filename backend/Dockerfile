FROM python:3.11-slim

WORKDIR /app

# 系统依赖（matplotlib 需要）
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential libffi-dev \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用 Docker 层缓存）
COPY backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# 复制后端代码（含已迁入的 tools/ 模块与 resources/ 资源）
COPY backend/app/ ./app/

# 复制 data 目录占位
COPY data/ ./data/

ENV PYTHONPATH=/app
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

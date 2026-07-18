"""JMeter Agent Server — configuration."""

from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    jmeter_home: Path = Path(r"C:\apache-jmeter-5.6.3")
    data_root: Path = Path(r"D:\JmeterAgent-Server\data")
    database_url: str = "sqlite:///./jmeter_agent.db"
    host: str = "0.0.0.0"
    port: int = 8080
    metrics_bucket_seconds: int = 5
    metrics_tail_interval_seconds: int = 3
    cors_origins: str = "http://localhost:5173,http://localhost:8080"
    # Classic PAT with `repo` scope — used to open GitHub Issues for Report Bug.
    github_token: str = ""
    github_repo: str = "nareshnakka/JmeterSolution"

    @property
    def jmeter_bin(self) -> Path:
        return self.jmeter_home / "bin" / "jmeter.bat"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()

# Ensure data root exists at import time
settings.data_root.mkdir(parents=True, exist_ok=True)

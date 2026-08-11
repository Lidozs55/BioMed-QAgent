"""Model registry: user-configured providers and the maintained model list.

The registry persists providers (alias + base URL + API key) and managed
models in a SQLite database, and supplies provider-specific parameter
profiles so the settings UI can auto-import models with editable parameters.
"""

from app.model_registry.store import ProviderModelStore

__all__ = ["ProviderModelStore"]

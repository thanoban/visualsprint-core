"""Owner/admin configuration for tenant-scoped capture providers."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.capture_v2 import get_capture_secret_store
from app.auth.dependency import require_org_admin
from app.capture.provider_resolver import validate_provider_base_url
from app.db.base import get_db
from app.db.models import ProviderBinding, ProviderBindingStatus, User
from app.interfaces.secretstore import SecretStore

router = APIRouter(prefix="/api/v2/workspaces/{org_id}/capture-provider", tags=["capture-v2"])


class ConfigureVexaRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint_url: str = Field(min_length=1, max_length=2048)
    api_key: SecretStr
    account_scope_id: str = Field(min_length=1, max_length=255)


class ProviderBindingView(BaseModel):
    id: str
    provider: str
    account_scope_id: str
    status: str


@router.put("/vexa", response_model=ProviderBindingView)
async def configure_vexa(
    org_id: str,
    body: ConfigureVexaRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_org_admin),
    secret_store: SecretStore = Depends(get_capture_secret_store),
) -> ProviderBindingView:
    try:
        endpoint = validate_provider_base_url(body.endpoint_url)
    except ValueError as exc:
        raise HTTPException(422, "provider endpoint must be HTTPS without credentials or a path") from exc
    api_key = body.api_key.get_secret_value()
    if not api_key.strip():
        raise HTTPException(422, "provider API key is required")

    owner = db.execute(
        select(ProviderBinding).where(
            ProviderBinding.provider == "vexa",
            ProviderBinding.account_scope_id == body.account_scope_id,
        )
    ).scalar_one_or_none()
    if owner is not None and owner.org_id != org_id:
        raise HTTPException(409, "provider account is already assigned to another workspace")
    bindings = db.execute(
        select(ProviderBinding).where(
            ProviderBinding.org_id == org_id,
            ProviderBinding.provider == "vexa",
        )
    ).scalars().all()
    if len(bindings) > 1:
        raise HTTPException(409, "multiple provider bindings require operator repair")

    endpoint_ref = f"capture-provider/{org_id}/vexa-endpoint"
    key_ref = f"capture-provider/{org_id}/vexa-key"
    await secret_store.put(endpoint_ref, endpoint)
    await secret_store.put(key_ref, api_key)
    binding = bindings[0] if bindings else ProviderBinding(org_id=org_id, provider="vexa")
    binding.endpoint_ref = endpoint_ref
    binding.secret_ref = key_ref
    binding.account_scope_id = body.account_scope_id
    binding.status = ProviderBindingStatus.ACTIVE
    db.add(binding)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        await secret_store.delete(endpoint_ref)
        await secret_store.delete(key_ref)
        raise HTTPException(409, "provider account binding conflicted") from exc
    return ProviderBindingView(
        id=binding.id,
        provider=binding.provider,
        account_scope_id=binding.account_scope_id,
        status=binding.status.value,
    )


@router.get("", response_model=ProviderBindingView)
def get_provider_binding(
    org_id: str,
    db: Session = Depends(get_db),
    _: User = Depends(require_org_admin),
) -> ProviderBindingView:
    binding = db.execute(
        select(ProviderBinding).where(
            ProviderBinding.org_id == org_id,
            ProviderBinding.provider == "vexa",
        )
    ).scalar_one_or_none()
    if binding is None:
        raise HTTPException(404, "capture provider is not configured")
    return ProviderBindingView(
        id=binding.id,
        provider=binding.provider,
        account_scope_id=binding.account_scope_id,
        status=binding.status.value,
    )

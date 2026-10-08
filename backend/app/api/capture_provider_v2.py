"""Owner/admin configuration for tenant-scoped capture providers."""

import uuid
from contextlib import suppress

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, SecretStr
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.capture_v2 import get_capture_secret_store
from app.auth.dependency import require_org_admin
from app.capture.provider_resolver import validate_provider_base_url
from app.db.base import get_db
from app.db.models import Org, ProviderBinding, ProviderBindingStatus, User
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
    user: User = Depends(require_org_admin),
    secret_store: SecretStore = Depends(get_capture_secret_store),
) -> ProviderBindingView:
    try:
        endpoint = validate_provider_base_url(body.endpoint_url)
    except ValueError as exc:
        raise HTTPException(
            422, "provider endpoint must be HTTPS without credentials or a path"
        ) from exc
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
    bindings = (
        db.execute(
            select(ProviderBinding).where(
                ProviderBinding.org_id == org_id,
                ProviderBinding.provider == "vexa",
            )
        )
        .scalars()
        .all()
    )
    if len(bindings) > 1:
        raise HTTPException(409, "multiple provider bindings require operator repair")
    if bindings and bindings[0].account_scope_id != body.account_scope_id:
        raise HTTPException(
            409, "provider account identity is immutable; operator migration required"
        )

    # A losing configuration race must never delete the previously active key.
    version = uuid.uuid4()
    endpoint_ref = f"capture-provider/{org_id}/{version}/endpoint"
    key_ref = f"capture-provider/{org_id}/{version}/key"
    db.commit()  # No row locks or transactions during SecretStore I/O.
    try:
        await secret_store.put(endpoint_ref, endpoint)
        await secret_store.put(key_ref, api_key)
        db.scalar(select(Org.id).where(Org.id == org_id).with_for_update())
        require_org_admin(org_id, user, db)  # Recheck after external I/O.
        bindings = list(
            db.scalars(
                select(ProviderBinding)
                .where(ProviderBinding.org_id == org_id, ProviderBinding.provider == "vexa")
                .execution_options(populate_existing=True)
            )
        )
        if len(bindings) > 1 or (
            bindings and bindings[0].account_scope_id != body.account_scope_id
        ):
            raise HTTPException(409, "provider account binding changed; operator repair required")
        binding = bindings[0] if bindings else ProviderBinding(org_id=org_id, provider="vexa")
        old_refs = {binding.endpoint_ref, binding.secret_ref} if bindings else set()
        binding.endpoint_ref, binding.secret_ref = endpoint_ref, key_ref
        binding.account_scope_id = body.account_scope_id
        binding.status = ProviderBindingStatus.ACTIVE
        db.add(binding)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        with suppress(Exception):
            await secret_store.delete(endpoint_ref)
            await secret_store.delete(key_ref)
        raise HTTPException(409, "provider account binding conflicted") from exc
    except Exception:
        db.rollback()
        with suppress(Exception):
            await secret_store.delete(endpoint_ref)
            await secret_store.delete(key_ref)
        raise
    for ref in old_refs:
        if (
            db.scalar(
                select(ProviderBinding.id)
                .where((ProviderBinding.endpoint_ref == ref) | (ProviderBinding.secret_ref == ref))
                .limit(1)
            )
            is None
        ):
            db.commit()
            with suppress(Exception):
                await secret_store.delete(ref)
    db.commit()
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

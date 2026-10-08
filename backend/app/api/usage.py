"""F13 usage metering — workspace spend, reservation and limit view.

Returns the caller's workspace usage for a billing period.  Reads from:
- UsageReservation rows (capture minutes reserved / reconciled)
- LlmCall rows (token counts for the period)
- Org.monthly_llm_token_budget / capture_monthly_minutes (configured limits)

No new tables: everything is already written by the capture worker and the
LLM accounting layer.  This endpoint is read-only and exposes IDs/numbers,
not meeting content.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth.dependency import get_current_user, require_org_member
from app.db.base import get_db
from app.db.models import LlmCall, Org, UsageReservation, UsageReservationStatus, User

router = APIRouter(prefix="/api/v2/workspaces/{org_id}", tags=["usage"])


class CaptureUsage(BaseModel):
    reserved_minutes: float
    reconciled_minutes: float
    limit_minutes: int | None


class LlmUsage(BaseModel):
    input_tokens: int
    output_tokens: int
    total_tokens: int
    budget_tokens: int | None
    over_budget: bool


class UsageView(BaseModel):
    org_id: str
    period_start: str
    period_end: str
    capture: CaptureUsage
    llm: LlmUsage


def _period_bounds(year: int, month: int) -> tuple[datetime, datetime]:
    start = datetime(year, month, 1, tzinfo=UTC)
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=UTC)
    else:
        end = datetime(year, month + 1, 1, tzinfo=UTC)
    return start, end


@router.get("/usage", response_model=UsageView)
def get_usage(
    org_id: str,
    year: int | None = Query(None, ge=2020, le=2100),
    month: int | None = Query(None, ge=1, le=12),
    db: Session = Depends(get_db),
    _user: User = Depends(get_current_user),
    __: None = Depends(require_org_member),
) -> UsageView:
    """Return workspace usage for a billing period.

    Defaults to the current UTC calendar month.  Capture minutes are read
    from UsageReservation rows; LLM tokens from LlmCall rows.
    """
    org = db.get(Org, org_id)
    if org is None:
        raise HTTPException(404, "workspace not found")

    now = datetime.now(UTC)
    y = year if year is not None else now.year
    m = month if month is not None else now.month
    period_start, period_end = _period_bounds(y, m)

    # --- capture minutes -------------------------------------------------
    reservations = (
        db.execute(
            select(UsageReservation).where(
                UsageReservation.org_id == org_id,
                UsageReservation.created_at >= period_start,
                UsageReservation.created_at < period_end,
                UsageReservation.unit.in_({"bot_second", "capture_minutes"}),
            )
        )
        .scalars()
        .all()
    )

    reserved_minutes = sum(
        float(r.estimated_quantity) / (60 if r.unit == "bot_second" else 1)
        for r in reservations
        if r.status == UsageReservationStatus.RESERVED
    )
    reconciled_minutes = sum(
        float(r.actual_quantity if r.actual_quantity is not None else r.estimated_quantity)
        / (60 if r.unit == "bot_second" else 1)
        for r in reservations
        if r.status == UsageReservationStatus.RECONCILED
    )

    # --- LLM tokens ------------------------------------------------------
    token_row = db.execute(
        select(
            func.coalesce(func.sum(LlmCall.input_tokens), 0),
            func.coalesce(func.sum(LlmCall.output_tokens), 0),
        ).where(
            LlmCall.org_id == org_id,
            LlmCall.at >= period_start,
            LlmCall.at < period_end,
        )
    ).one()
    input_tokens = int(token_row[0])
    output_tokens = int(token_row[1])
    total_tokens = input_tokens + output_tokens

    budget = org.monthly_llm_token_budget
    over_budget = budget is not None and total_tokens >= budget

    return UsageView(
        org_id=org_id,
        period_start=period_start.isoformat(),
        period_end=period_end.isoformat(),
        capture=CaptureUsage(
            reserved_minutes=reserved_minutes,
            reconciled_minutes=reconciled_minutes,
            limit_minutes=org.capture_monthly_minutes,
        ),
        llm=LlmUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            budget_tokens=budget,
            over_budget=over_budget,
        ),
    )

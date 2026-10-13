"""Turns Handrail's JSON Schemas into Pydantic models, which LangChain and CrewAI need as args_schema."""

from __future__ import annotations

import keyword
import re
from typing import Any, Dict, List, Literal, Optional, Tuple, Type

from pydantic import BaseModel, ConfigDict, Field, create_model

_SCALARS: Dict[str, Any] = {"string": str, "integer": int, "number": float, "boolean": bool}


def _camel(name: str) -> str:
    return "".join(part.capitalize() for part in re.split(r"[^A-Za-z0-9]+", name) if part) or "Args"


def _field_name(prop: str) -> Tuple[str, Optional[str]]:
    """A valid Python field name for a property, and its alias when they differ."""
    name = re.sub(r"\W", "_", prop)
    if not name or name[0].isdigit() or keyword.iskeyword(name) or name.startswith("_") or name in ("schema", "copy", "json", "dict"):
        name = f"f_{name}"
    return name, (prop if name != prop else None)


def _type_for(schema: Dict[str, Any], name: str) -> Any:
    if "enum" in schema and all(isinstance(v, str) for v in schema["enum"]) and schema["enum"]:
        return Literal[tuple(schema["enum"])]  # type: ignore[misc]
    kind = schema.get("type")
    if isinstance(kind, list):  # e.g. ["string", "null"]
        kind = next((k for k in kind if k != "null"), None)
    if kind in _SCALARS:
        return _SCALARS[kind]
    if kind == "array":
        return List[_type_for(schema.get("items") or {}, f"{name}Item")]  # type: ignore[misc]
    if kind == "object" or "properties" in schema:
        if schema.get("properties"):
            return model_from_schema(name, schema)
        return Dict[str, Any]
    return Any  # anyOf/oneOf and anything else: passed through as given


def model_from_schema(name: str, schema: Dict[str, Any]) -> Type[BaseModel]:
    """A Pydantic model for an object schema. Optional fields default to None and are left out when sent."""
    required = set(schema.get("required") or [])
    fields: Dict[str, Any] = {}
    for prop, prop_schema in (schema.get("properties") or {}).items():
        field, alias = _field_name(prop)
        annotation = _type_for(prop_schema or {}, f"{name}{_camel(prop)}")
        description = (prop_schema or {}).get("description")
        if prop in required:
            fields[field] = (annotation, Field(..., description=description, alias=alias))
        else:
            fields[field] = (Optional[annotation], Field(None, description=description, alias=alias))
    return create_model(  # type: ignore[call-overload]
        _camel(name),
        __config__=ConfigDict(populate_by_name=True, protected_namespaces=(), extra="allow"),
        **fields,
    )


def to_plain(value: Any) -> Any:
    """Validated tool input back to plain JSON: models to dicts (by original names), None values dropped."""
    if isinstance(value, BaseModel):
        return to_plain(value.model_dump(by_alias=True, exclude_none=True))
    if isinstance(value, dict):
        return {k: to_plain(v) for k, v in value.items() if v is not None}
    if isinstance(value, (list, tuple)):
        return [to_plain(v) for v in value]
    return value

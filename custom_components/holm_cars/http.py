"""Fichiers de HOLM Cars (photos des voitures, factures) : envoi et lecture protégés par l'authentification."""
from __future__ import annotations

import mimetypes
import os
import re

from aiohttp import web

from homeassistant.components.http import HomeAssistantView

from .const import DOMAIN, FILES_URL, MAX_UPLOAD, UPLOAD_URL
from .store import new_id

ALLOWED = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".pdf", ".txt", ".csv", ".doc", ".docx", ".xls", ".xlsx", ".odt"}


class FileView(HomeAssistantView):
    """Lecture d'un fichier. Les balises <img> passent par un lien signé (auth/sign_path)."""
    url = FILES_URL + "/{name}"
    name = "api:holm_cars:file"
    requires_auth = True

    async def get(self, request: web.Request, name: str) -> web.StreamResponse:
        hass = request.app["hass"]
        store = hass.data[DOMAIN]["store"]
        name = os.path.basename(name)
        path = os.path.join(store.files_dir, name)
        if not re.fullmatch(r"[0-9a-f]{12}\.[a-z0-9]{1,5}", name) or not await hass.async_add_executor_job(os.path.isfile, path):
            return web.Response(status=404)
        ctype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        return web.FileResponse(path, headers={"Content-Type": ctype, "Cache-Control": "private, max-age=86400"})


class UploadView(HomeAssistantView):
    url = UPLOAD_URL
    name = "api:holm_cars:upload"
    requires_auth = True

    async def post(self, request: web.Request) -> web.Response:
        hass = request.app["hass"]
        store = hass.data[DOMAIN]["store"]
        reader = await request.multipart()
        field = await reader.next()
        if field is None or field.name != "file":
            return self.json_message("Fichier manquant", 400)
        label = os.path.basename(field.filename or "fichier")
        ext = os.path.splitext(label)[1].lower() or mimetypes.guess_extension(field.headers.get("Content-Type", "")) or ""
        if ext not in ALLOWED:
            return self.json_message("Type de fichier non accepté", 400)
        chunks, size = [], 0
        while chunk := await field.read_chunk(256 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD:
                return self.json_message("Fichier trop gros (25 Mo maximum)", 413)
            chunks.append(chunk)
        fid = new_id() + (".jpg" if ext == ".jpeg" else ext)

        def write():
            with open(os.path.join(store.files_dir, fid), "wb") as f:
                for c in chunks:
                    f.write(c)
        await hass.async_add_executor_job(write)
        return self.json({"name": fid, "label": label, "size": size, "mime": mimetypes.guess_type(fid)[0] or ""})

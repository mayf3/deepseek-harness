# Agent Note: Provider-resolved image paths in model requests

Status: implemented

English | [中文](2026-08-21-model-readable-image-paths.zh.md)

## Problem

An uploaded image becomes an opaque durable `ImageAttachmentRef`. Image-capable models receive its request preview, but the prior descriptor gives them no filesystem location for later image operations. Agents consequently search the workspace and temporary directories or ask the user where the file is. The request preview and stored normalized attachment may both differ from the upload, so their dimensions, format, and byte size cannot establish the upload's original properties.

## Decision

`ImageAttachmentRef` remains portable session data and contains no host path. `AttachmentStore.imageAccess(ref)` resolves optional access facts from the current provider. The local provider derives an absolute immutable-object path from the resolved `DSH_HOME`, attachment storage version, and validated digest. A request version carries these facts transiently for serialization. A provider without model-readable local storage returns no access facts.

The shared LLM image descriptor names the display name or full attachment id, the exact request-preview dimensions, and the provider-resolved normalized path when available. Local access text includes normalized dimensions and media type, identifies the object as read-only, directs the model to copy it to a writable path with the matching extension before editing, and states that normalization or request projection may have resized or re-encoded the upload. DeepSeek Files and pi-ai inline requests use the same descriptor.

Request-size offload requires a per-image placeholder function; the previous shared placeholder constant and its byte-bound wrapper had no remaining production caller and are removed. DeepSeek and pi-ai replace each omitted occurrence with its own attachment identity and current access facts without reading or transforming the omitted object. Offload selection, byte accounting, and quantized prefix behavior remain unchanged.

Descriptor identity comes from each occurrence's own durable reference, not from the prepared request version: versions are deduplicated per attachment id, so two uploads of the same content under different names share one version while each occurrence keeps its own display name. Access resolution validates the logged attachment id; a malformed reference in durable history fails the request at assembly, the earliest point that resolves it.

Absolute paths stay out of session events. Model-visible path text is reconstructed from the logged attachment reference and the provider mounted for the current process. Restoring the same session with a different `DSH_HOME` therefore produces the path that is valid on that host. The attachment object remains immutable; model instructions require a writable copy for modifications.

## Alternatives considered

**Persist the absolute path in `ImageAttachmentRef`.** A durable host path becomes stale after moving a session, changing `DSH_HOME`, or mounting another provider. Resolving it at request time preserves portable history.

**Teach each LLM adapter the `~/.dsh` layout.** Explicit `dshHome` and `$DSH_HOME` can select another root, and non-local providers may expose no path. The attachment provider owns this fact.

**Add a dedicated crop or recovery tool.** Standard filesystem and image tools can operate after copying the normalized object. A new tool adds a model schema and access-policy surface without being necessary for path discovery.

## Verification

Package tests cover provider access defaults, local digest-to-path resolution, request-version access propagation, retained-image descriptions, per-image nested offload placeholders, source-property warnings, and matching extensions. A keyless assembled ACP snapshot checks the exact local object path in both a retained DeepSeek Files image handle and an offloaded image placeholder.

## Consequences

The selected model provider receives a host path that was previously local-only. This disclosure is required for the model to operate on the stored image and is limited to normalized attachment objects already in that request's authorized history. Descriptor text adds tokens for every retained or offloaded image. Paths change when the provider root changes, while deterministic image bytes and session references remain unchanged. A missing local object still fails when a model tool attempts to read it.

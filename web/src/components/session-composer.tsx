import { useEffect, useRef, useState, type RefObject } from "react"
import { ATTACHMENT_MAX_COUNT, fileToAttachment, type AttachmentPart } from "../attachments"
import { CloseIcon, PaperclipIcon, SendIcon, StopCircleIcon } from "../Icons"
import type { Translator } from "../i18n"

/** The conversation input has a deliberately narrow interface: it owns input and attachment
 * presentation, while session state and network operations stay with the coordinator. */
export function SessionComposer({
  selected,
  attachmentContextKey,
  value,
  attachments,
  supportsAttachments,
  showStopAction,
  canAbortSession,
  mutationLocked,
  softKeyboard,
  t,
  composerRef,
  inputRef,
  attachmentInputRef,
  onValueChange,
  onAttachmentsChange,
  onAttachmentError,
  onFocus,
  onSend,
  onAbort
}: {
  selected: boolean
  /** Changes whenever the composer belongs to a different session/profile/config. */
  attachmentContextKey: string
  value: string
  attachments: AttachmentPart[]
  supportsAttachments: boolean
  showStopAction: boolean
  canAbortSession: boolean
  mutationLocked: boolean
  softKeyboard: boolean
  t: Translator
  composerRef: RefObject<HTMLDivElement>
  inputRef: RefObject<HTMLTextAreaElement>
  attachmentInputRef: RefObject<HTMLInputElement>
  onValueChange: (value: string) => void
  onAttachmentsChange: (next: AttachmentPart[] | ((current: AttachmentPart[]) => AttachmentPart[])) => void
  onAttachmentError: (message: string) => void
  onFocus: () => void
  onSend: () => void
  onAbort: () => void
}) {
  // File decoding is asynchronous. In particular, a large image can finish after the user has
  // navigated away, at which point appending it would stage it in the replacement session.
  const attachmentRequestState = useRef({ contextKey: attachmentContextKey, generation: 0 })
  const mountedRef = useRef(true)
  useEffect(() => {
    // Strict Mode simulates an unmount/remount. Mark the new effect instance live again so a
    // decode started by the remounted composer is not discarded forever.
    mountedRef.current = true
    return () => {
      // A decode can resolve after this composer has been replaced. Invalidate it before the
      // replacement is allowed to stage anything in the shared parent state.
      mountedRef.current = false
      attachmentRequestState.current.generation += 1
    }
  }, [])
  // Do this during render, rather than in an effect: a completed decode must not slip between the
  // replacement render and the effect that records the new context.
  if (attachmentRequestState.current.contextKey !== attachmentContextKey) {
    attachmentRequestState.current = {
      contextKey: attachmentContextKey,
      generation: attachmentRequestState.current.generation + 1
    }
  }
  // Keep the count tied to both the context and the generation. A decode from the previous
  // session may still be settling after navigation; it must not leave the replacement composer
  // looking busy (or make a later visit to the same session inherit that count).
  const [pendingPreparationState, setPendingPreparationState] = useState({
    contextKey: attachmentContextKey,
    generation: 0,
    count: 0
  })
  const pendingPreparation = pendingPreparationState.contextKey === attachmentContextKey
    && pendingPreparationState.generation === attachmentRequestState.current.generation
    ? pendingPreparationState.count
    : 0
  const invalidateAttachmentPreparation = () => {
    attachmentRequestState.current.generation += 1
  }
  const sendNow = () => {
    // Invalidate before calling into the coordinator. This closes the synchronous gap where a
    // decode can finish after send clears the staged attachments.
    invalidateAttachmentPreparation()
    onSend()
  }

  return (
    <div className="composer" ref={composerRef}>
      {attachments.length > 0 && <div className="composer-chips">
        {attachments.map((attachment, index) => <span className="composer-chip" key={`${attachment.filename}-${index}`}>
          <strong>{attachment.filename}</strong>
          <button className="btn-ghost btn-icon" aria-label={t('detail.removeAttachment')} disabled={mutationLocked} onClick={() => onAttachmentsChange((current) => current.filter((_, position) => position !== index))}>
            <CloseIcon size={12} />
          </button>
        </span>)}
      </div>}
      <textarea
        ref={inputRef}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={t('detail.composerPlaceholder')}
        enterKeyHint={softKeyboard ? "enter" : "send"}
        autoCapitalize="sentences"
        autoCorrect="on"
        onFocus={onFocus}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          if (softKeyboard) {
            if (event.ctrlKey || event.metaKey) { event.preventDefault(); if (!mutationLocked && pendingPreparation === 0) sendNow() }
            return
          }
          if (!event.shiftKey) { event.preventDefault(); if (!mutationLocked && pendingPreparation === 0) sendNow() }
        }}
        disabled={!selected}
      />
      <div className="composer-bar">
        {supportsAttachments && <>
          <input ref={attachmentInputRef} type="file" accept="image/*" multiple hidden onChange={async (event) => {
            const chosen = Array.from(event.target.files ?? []).slice(0, ATTACHMENT_MAX_COUNT - attachments.length)
            event.target.value = ""
            if (!chosen.length) return
            const requestGeneration = attachmentRequestState.current.generation
            const preparationContext = attachmentContextKey
            const preparationGeneration = requestGeneration
            setPendingPreparationState((current) => current.contextKey === preparationContext && current.generation === preparationGeneration
              ? { ...current, count: current.count + 1 }
              : { contextKey: preparationContext, generation: preparationGeneration, count: 1 })
            try {
              const prepared = await Promise.all(chosen.map((file) => fileToAttachment(file)))
               if (!mountedRef.current || requestGeneration !== attachmentRequestState.current.generation) return
              // The picker is disabled while work is pending, but keep the invariant here too:
              // multiple native change events can still be queued before React paints disabled.
              onAttachmentsChange((current) => [
                ...current,
                ...prepared.slice(0, Math.max(0, ATTACHMENT_MAX_COUNT - current.length))
              ])
            } catch (err) {
              if (mountedRef.current && requestGeneration === attachmentRequestState.current.generation) onAttachmentError((err as Error).message)
            } finally {
              if (!mountedRef.current) return
              setPendingPreparationState((current) => current.contextKey === preparationContext && current.generation === preparationGeneration
                ? { ...current, count: Math.max(0, current.count - 1) }
                : current)
            }
          }} />
          <button className="btn-ghost btn-icon" title={t('detail.attachImage')} aria-label={t('detail.attachImage')} onClick={() => attachmentInputRef.current?.click()} disabled={!selected || mutationLocked || pendingPreparation > 0 || attachments.length >= ATTACHMENT_MAX_COUNT}>
            <PaperclipIcon size={18} />
          </button>
        </>}
        <div className="composer-actions"><button onClick={showStopAction ? onAbort : sendNow} disabled={!selected || (!showStopAction && mutationLocked) || (!showStopAction && pendingPreparation > 0) || (showStopAction && !canAbortSession)} className={showStopAction ? "btn-danger composer-send" : "btn-primary composer-send"}>{showStopAction ? <StopCircleIcon size={18} /> : <SendIcon size={18} />}</button></div>
      </div>
    </div>
  )
}

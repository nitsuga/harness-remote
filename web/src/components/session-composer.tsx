import { useRef, useState, type RefObject } from "react"
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
  // Do this during render, rather than in an effect: a completed decode must not slip between the
  // replacement render and the effect that records the new context.
  if (attachmentRequestState.current.contextKey !== attachmentContextKey) {
    attachmentRequestState.current = {
      contextKey: attachmentContextKey,
      generation: attachmentRequestState.current.generation + 1
    }
  }
  const [pendingPreparation, setPendingPreparation] = useState(0)
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
            setPendingPreparation((count) => count + 1)
            try {
              const prepared = await Promise.all(chosen.map((file) => fileToAttachment(file)))
              if (requestGeneration !== attachmentRequestState.current.generation) return
              onAttachmentsChange((current) => [...current, ...prepared])
            } catch (err) {
              if (requestGeneration === attachmentRequestState.current.generation) onAttachmentError((err as Error).message)
            } finally {
              setPendingPreparation((count) => Math.max(0, count - 1))
            }
          }} />
          <button className="btn-ghost btn-icon" title={t('detail.attachImage')} aria-label={t('detail.attachImage')} onClick={() => attachmentInputRef.current?.click()} disabled={!selected || mutationLocked || attachments.length >= ATTACHMENT_MAX_COUNT}>
            <PaperclipIcon size={18} />
          </button>
        </>}
        <div className="composer-actions"><button onClick={showStopAction ? onAbort : sendNow} disabled={!selected || mutationLocked || (!showStopAction && pendingPreparation > 0)} className={showStopAction ? "btn-danger composer-send" : "btn-primary composer-send"}>{showStopAction ? <StopCircleIcon size={18} /> : <SendIcon size={18} />}</button></div>
      </div>
    </div>
  )
}

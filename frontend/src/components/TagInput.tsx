import { useId, useRef, type KeyboardEvent } from 'react'

const MAX_TAGS = 5

interface TagInputProps {
  tags: string[]
  onChange: (tags: string[]) => void
}

export default function TagInput({ tags, onChange }: TagInputProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  function addTag(raw: string) {
    const value = raw.trim()
    if (!value) return
    if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) return
    if (tags.length >= MAX_TAGS) return
    onChange([...tags, value])
  }

  function removeTag(tag: string) {
    onChange(tags.filter((t) => t !== tag))
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      const input = e.currentTarget
      addTag(input.value)
      input.value = ''
    } else if (e.key === 'Backspace' && e.currentTarget.value === '' && tags.length > 0) {
      onChange(tags.slice(0, -1))
    }
  }

  return (
    <div className="tag-input">
      <div className="tag-input-chips" onClick={() => inputRef.current?.focus()}>
        {tags.map((tag) => (
          <span key={tag} className="tag-chip">
            {tag}
            <button type="button" className="tag-chip-remove" onClick={() => removeTag(tag)} aria-label={`Remove ${tag}`}>
              ×
            </button>
          </span>
        ))}
        {tags.length < MAX_TAGS && (
          <input
            ref={inputRef}
            id={inputId}
            className="tag-input-field"
            placeholder={tags.length === 0 ? 'Type a tag and press Enter' : 'Add another tag…'}
            onKeyDown={onKeyDown}
            onBlur={(e) => {
              if (e.target.value.trim()) {
                addTag(e.target.value)
                e.target.value = ''
              }
            }}
          />
        )}
      </div>
      <div className="tag-input-hint">{tags.length}/{MAX_TAGS} tags</div>
    </div>
  )
}

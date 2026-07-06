import { useId, useRef } from 'react'

interface FilePickerProps {
  label: string
  buttonText: string
  accept?: string
  multiple?: boolean
  files: File[]
  onChange: (files: File[]) => void
  emptyText?: string
}

export default function FilePicker({
  label,
  buttonText,
  accept,
  multiple = false,
  files,
  onChange,
  emptyText = 'No files selected',
}: FilePickerProps) {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  function onFilesSelected(fileList: FileList | null) {
    if (!fileList?.length) return
    const incoming = Array.from(fileList)
    if (multiple) {
      const names = new Set(files.map((f) => f.name))
      const added = incoming.filter((f) => !names.has(f.name))
      onChange([...files, ...added])
    } else {
      onChange([incoming[0]])
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  function removeFile(name: string) {
    onChange(files.filter((f) => f.name !== name))
  }

  return (
    <div className="file-picker">
      <label className="file-picker-label">{label}</label>
      <div className="file-picker-controls">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          className="file-picker-input"
          accept={accept}
          multiple={multiple}
          onChange={(e) => onFilesSelected(e.target.files)}
        />
        <button type="button" className="btn btn-secondary" onClick={() => inputRef.current?.click()}>
          {buttonText}
        </button>
        {files.length > 0 && (
          <span className="file-picker-count">
            {files.length} file{files.length !== 1 ? 's' : ''} selected
          </span>
        )}
      </div>
      <div className="file-picker-list">
        {files.length === 0 ? (
          <div className="file-picker-empty">{emptyText}</div>
        ) : (
          files.map((f) => (
            <div key={f.name} className="file-picker-item">
              <span className="file-picker-name">{f.name}</span>
              <span className="file-picker-size">{(f.size / 1024).toFixed(1)} KB</span>
              <button type="button" className="file-picker-remove" onClick={() => removeFile(f.name)}>
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

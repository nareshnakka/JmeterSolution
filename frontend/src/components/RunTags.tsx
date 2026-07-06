interface RunTagsProps {
  tags?: string[]
}

export default function RunTags({ tags }: RunTagsProps) {
  if (!tags?.length) return <>—</>
  return (
    <span className="tag-list">
      {tags.map((t) => (
        <span key={t} className="tag-chip tag-chip-readonly">{t}</span>
      ))}
    </span>
  )
}

import { ROLES, parseRoles } from '../../src/core/roles.js';

export type ActionRow = { key: number; action: string; deadline: string; appliesTo: string };

export type ActionRowProps = {
  row: ActionRow;
  index: number;
  onToggleRole: (index: number, role: string) => void;
  onChangeAppliesTo: (index: number, appliesTo: string) => void;
  onRemove: (key: number) => void;
};

/** One repeatable "Actions required" row: action text, UTC deadline, role tags, remove. */
export function ActionRowFields({ row, index, onToggleRole, onChangeAppliesTo, onRemove }: ActionRowProps) {
  return (
    <div className="row-repeat">
      <input
        type="text"
        name={`action.${index}`}
        placeholder="Action (e.g. Update your node)"
        defaultValue={row.action}
        aria-label="Action"
      />
      <input
        type="datetime-local"
        name={`deadline.${index}`}
        defaultValue={row.deadline}
        aria-label="Deadline"
        aria-describedby={`deadline-utc-hint.${index}`}
      />
      <span id={`deadline-utc-hint.${index}`} className="hint hint-inline">UTC</span>
      <div className="role-tags" role="group" aria-label="Applies to">
        {ROLES.map(role => {
          const active = parseRoles(row.appliesTo).includes(role);
          return (
            <button
              type="button"
              key={role}
              className="role-tag"
              aria-pressed={active}
              onClick={() => onToggleRole(index, role)}
            >
              {role}
            </button>
          );
        })}
      </div>
      <input
        type="text"
        name={`appliesTo.${index}`}
        placeholder="Or type roles, comma-separated"
        aria-label="Applies to (comma-separated roles)"
        value={row.appliesTo}
        onChange={e => onChangeAppliesTo(index, e.target.value)}
      />
      <button
        type="button"
        className="secondary"
        onClick={() => onRemove(row.key)}
      >
        Remove
      </button>
    </div>
  );
}

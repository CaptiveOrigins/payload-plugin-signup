import type { Access, CollectionConfig, Field, GlobalConfig, PayloadRequest } from 'payload'

import { isManager } from './access.js'
import { decide } from './flow.js'
import { MODES, type ResolvedSignup } from './types.js'
import { SignupError } from './util.js'

const nobody = () => false

/** Sign-up requests: the queue staff work through. Made only by the plugin; staff change only the decision. */
export function requestsCollection(o: ResolvedSignup): CollectionConfig {
  // Only an exact `true` from `access.manage` makes a manager; a truthy value, a query or a thrown error is a no.
  const manager: Access = (args) => isManager(o, args)
  const internal = { hidden: true }
  return {
    slug: o.requests,
    labels: { singular: 'Sign-up request', plural: 'Sign-up requests' },
    admin: {
      group: o.adminGroup,
      useAsTitle: 'email',
      defaultColumns: ['email', 'status', 'flag', 'createdAt'],
      description:
        'People asking for an account. Open one and set Status to Approved or Declined, or select several and use Edit. Unverified ones haven\'t confirmed their email yet, and have no account. Decided, abandoned and unverified requests are deleted after ' +
        `${o.retentionDays} days.`,
      listSearchableFields: ['email'],
    },
    access: { read: manager, update: manager, create: nobody, delete: manager },
    fields: [
      { name: 'email', type: 'email', required: true, index: true, admin: { readOnly: true } },
      {
        name: 'status',
        type: 'select',
        required: true,
        defaultValue: 'unverified',
        index: true,
        options: [
          { label: 'Unverified', value: 'unverified' },
          { label: 'Waiting for a decision', value: 'pending' },
          { label: 'Approved', value: 'approved' },
          { label: 'Declined', value: 'declined' },
        ],
        admin: { position: 'sidebar', description: 'Change a waiting request to Approved or Declined. Nothing else can be changed here.' },
      },
      { name: 'flag', type: 'text', admin: { readOnly: true, position: 'sidebar', description: 'Something the site\'s checks want you to see, for example that the person is a minor.' } },
      {
        name: 'note',
        type: 'textarea',
        maxLength: 500,
        admin: { description: 'Optional. Sent to them with a decline, word for word. Leave it empty for the standard polite email.' },
      },
      { name: 'details', type: 'group', fields: o.fields.length ? o.fields : [{ name: 'none', type: 'text', admin: { hidden: true } }], admin: { readOnly: true } },
      { name: 'user', type: 'relationship', relationTo: o.users as never, admin: { readOnly: true, position: 'sidebar' } },
      { name: 'verifiedAt', type: 'date', admin: { readOnly: true, position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'decidedAt', type: 'date', index: true, admin: { readOnly: true, position: 'sidebar', date: { pickerAppearance: 'dayAndTime' } } },
      { name: 'decidedBy', type: 'relationship', relationTo: o.users as never, admin: { readOnly: true, position: 'sidebar', description: 'Empty when it was approved automatically (open sign-up).' } },
      // What the site's checks set for the account (a minor flag, say): applied on confirming, read by nobody.
      { name: 'userData', type: 'json', admin: internal, access: { read: nobody } },
      { name: 'tokenHash', type: 'text', index: true, admin: internal, access: { read: nobody } },
      { name: 'tokenExpires', type: 'date', admin: internal },
    ],
    hooks: {
      beforeChange: [
        async ({ data, originalDoc, operation, req, context }) => {
          if (operation !== 'update' || context?.signupInternal) return data
          // Staff change only the decision, and only on a waiting request. Everything else stays as the plugin wrote it.
          const from = originalDoc?.status
          const to = data.status ?? from
          for (const key of ['email', 'details', 'user', 'flag', 'verifiedAt', 'decidedAt', 'decidedBy', 'userData', 'tokenHash', 'tokenExpires']) data[key] = originalDoc?.[key]
          if (to === from) return data
          if (from !== 'pending') throw new SignupError('notWaiting', from === 'unverified' ? 'This request isn\'t verified yet, so it can\'t be decided.' : 'This request has already been decided.')
          if (to !== 'approved' && to !== 'declined') throw new SignupError('badDecision', 'A waiting request can only be approved or declined.')
          return decide(req.payload, { ...originalDoc, ...data }, to, req)
        },
      ],
    },
    timestamps: true,
  }
}

/** The mode, and what the form says while sign-up is shut. */
export function settingsGlobal(o: ResolvedSignup): GlobalConfig {
  const manager: Access = (args) => isManager(o, args)
  return {
    slug: o.settings,
    label: 'Sign-up settings',
    admin: { group: o.adminGroup },
    access: { read: manager, update: manager },
    fields: [
      {
        name: 'mode',
        type: 'select',
        required: true,
        defaultValue: 'closed',
        options: [
          { label: 'Open: anyone who confirms their email gets an account', value: MODES[0]! },
          { label: 'Approval: requests wait for a person to approve them', value: MODES[1]! },
          { label: 'Invite only: the form is shut; accounts come from invitations', value: MODES[2]! },
          { label: 'Closed: nobody can ask', value: MODES[3]! },
        ],
        admin: {
          description: o.forceMode ? `Locked to "${o.forceMode}" by the site's configuration; this setting is ignored until that's removed.` : 'Takes effect at once, with no deploy.',
        },
      },
      { name: 'inviteOnlyMessage', type: 'textarea', maxLength: 500, admin: { description: 'Shown on the form in invite-only mode. Empty: "Sign-up is by invitation for now."' } },
      { name: 'closedMessage', type: 'textarea', maxLength: 500, admin: { description: 'Shown on the form when closed. Empty: "Sign-up is closed for now."' } },
    ],
  }
}

/** Rate-limit counts for the built-in limiter: hashed keys and times, nothing else. */
export function attemptsCollection(o: ResolvedSignup): CollectionConfig {
  return {
    slug: o.attempts,
    admin: { hidden: true },
    access: { read: nobody, create: nobody, update: nobody, delete: nobody },
    fields: [
      { name: 'kind', type: 'text', required: true, index: true },
      { name: 'keyHash', type: 'text', required: true, index: true },
      { name: 'at', type: 'date', required: true, index: true },
    ],
  }
}

/** Added to the auth collection: where an account is in sign-up. Accounts made any other way are active. */
export function signupStatusField(o: ResolvedSignup): Field {
  return {
    name: 'signupStatus',
    type: 'select',
    defaultValue: 'active',
    index: true,
    options: [
      { label: 'Active', value: 'active' },
      { label: 'Waiting for approval', value: 'pending' },
    ],
    // Read by the account itself and by sign-up's managers; set only by the plugin.
    access: {
      create: nobody,
      update: nobody,
      read: async (args) => {
        const { req, doc } = args as { req: PayloadRequest; doc?: { id?: unknown } }
        if (!req.user) return false
        if (doc?.id !== undefined && String(req.user.id) === String(doc.id)) return true
        return isManager(o, args as { req: PayloadRequest })
      },
    },
    admin: { position: 'sidebar', readOnly: true, description: 'Set by sign-up. Only active accounts can sign in.' },
  }
}

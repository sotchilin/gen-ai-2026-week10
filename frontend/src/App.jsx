import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Accessibility,
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  CalendarDays,
  Check,
  ChevronRight,
  ClipboardList,
  Clock3,
  HeartPulse,
  LayoutDashboard,
  Menu,
  Minus,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Type,
  Utensils,
  Users,
  X,
} from 'lucide-react'
import './App.css'

const today = () => {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const monthNow = () => today().slice(0, 7)
const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'residents', label: 'Residents', icon: Users },
  { id: 'schedule', label: 'Schedule', icon: CalendarDays },
  { id: 'logistics', label: 'Logistics', icon: ClipboardList },
  { id: 'reports', label: 'Reports', icon: Activity },
]

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, options)
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!response.ok) {
    throw new Error(data?.detail || data?.message || `Request failed (${response.status})`)
  }
  return data
}

function jsonOptions(method, payload) {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

function App() {
  const [page, setPage] = useState('dashboard')
  const [textScale, setTextScale] = useState(() => {
    const savedScale = Number(window.localStorage.getItem('ot-text-scale'))
    return savedScale >= 85 && savedScale <= 130 ? savedScale : 100
  })
  const [date, setDate] = useState(today())
  const [dashboard, setDashboard] = useState(null)
  const [residents, setResidents] = useState([])
  const [groups, setGroups] = useState([])
  const [sessions, setSessions] = useState([])
  const [health, setHealth] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [modal, setModal] = useState('')
  const [search, setSearch] = useState('')
  const [selectedResident, setSelectedResident] = useState(null)
  const [residentTrend, setResidentTrend] = useState([])
  const [selectedSession, setSelectedSession] = useState(null)
  const [enrollments, setEnrollments] = useState([])
  const [reportMonth, setReportMonth] = useState(monthNow())
  const [reportRange, setReportRange] = useState({ start: today(), end: today() })
  const [engagement, setEngagement] = useState(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [healthData, dashboardData, residentData, groupData, sessionData] = await Promise.all([
        request('/health'),
        request(`/dashboard?on_date=${date}`),
        request('/residents'),
        request('/therapy-groups'),
        request(`/sessions?scheduled_date=${date}`),
      ])
      setHealth(healthData)
      setDashboard(dashboardData)
      setResidents(residentData)
      setGroups(groupData)
      setSessions(sessionData)
    } catch (requestError) {
      setError(requestError.message)
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    window.localStorage.setItem('ot-text-scale', String(textScale))
  }, [textScale])

  const visibleResidents = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return residents
    return residents.filter((resident) => {
      const bedAliases = resident.bed_number == null
        ? []
        : [
          `${resident.room_number}-${resident.bed_number}`,
          `${resident.room_number}-${String(resident.bed_number).padStart(2, '0')}`,
        ]
      return [resident.name, resident.room_number, resident.bed_number, ...bedAliases]
        .some((value) => String(value ?? '').toLowerCase().includes(term))
    })
  }, [residents, search])

  const openResident = async (resident) => {
    setSelectedResident(resident)
    setResidentTrend([])
    try {
      const [detail, trend] = await Promise.all([
        request(`/residents/${resident.resident_id}`),
        request(`/analytics/residents/${resident.resident_id}/trend?years=5`),
      ])
      setSelectedResident(detail)
      setResidentTrend(trend)
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const openSession = async (session) => {
    setSelectedSession(session)
    setPage('logistics')
    try {
      setEnrollments(await request(`/sessions/${session.session_id}/enrollments`))
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const submitForm = async (event, endpoint, method, values, successMessage, refreshAfter = true) => {
    event.preventDefault()
    setError('')
    setMessage('')
    try {
      await request(endpoint, jsonOptions(method, values))
      setModal('')
      setMessage(successMessage)
      if (refreshAfter) await refresh()
      if (selectedResident) await openResident(selectedResident)
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const editResident = async (event) => {
    const form = new FormData(event.currentTarget)
    await submitForm(event, `/residents/${selectedResident.resident_id}`, 'PATCH', {
      name: form.get('name'),
      room_number: form.get('room_number'),
      bed_number: form.get('bed_number') ? Number(form.get('bed_number')) : null,
      has_dementia: form.get('has_dementia') === 'on',
      requires_wheelchair: form.get('requires_wheelchair') === 'on',
      status: form.get('status'),
    }, 'Resident updated.')
  }

  const updateEnrollment = async (enrollmentId, updates) => {
    setError('')
    try {
      await request(`/enrollments/${enrollmentId}`, jsonOptions('PATCH', updates))
      setEnrollments(await request(`/sessions/${selectedSession.session_id}/enrollments`))
      await refresh()
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const addEnrollment = async (event) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const residentId = Number(form.get('resident_id'))
    if (!residentId) return
    try {
      await request(
        `/sessions/${selectedSession.session_id}/enrollments`,
        jsonOptions('POST', { resident_id: residentId, transfer_type: form.get('transfer_type') }),
      )
      setEnrollments(await request(`/sessions/${selectedSession.session_id}/enrollments`))
      await refresh()
      formElement.reset()
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const downloadReport = async () => {
    setError('')
    try {
      const response = await fetch(`/api/reports/monthly.csv?month=${reportMonth}`)
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.detail || `Request failed (${response.status})`)
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `ot-treatment-record-${reportMonth}.csv`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  const loadEngagement = async (event) => {
    event.preventDefault()
    setError('')
    try {
      const params = new URLSearchParams({
        start_date: reportRange.start,
        end_date: reportRange.end,
      })
      setEngagement(await request(`/analytics/engagement?${params}`))
    } catch (requestError) {
      setError(requestError.message)
    }
  }

  return (
    <div className="app-shell" style={{ '--text-scale': textScale / 100 }}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><HeartPulse size={22} /></div>
          <div><strong>Chilin OT</strong><span>Care operations</span></div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="navigation" aria-label="Main navigation">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}>
                <Icon size={18} /><span>{item.label}</span>{page === item.id && <ChevronRight className="nav-chevron" size={15} />}
              </button>
            )
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><ShieldCheck size={17} /><span>Local safety checks enabled</span></div>
          <div className="profile-chip"><div className="avatar">OT</div><div><strong>OT Team</strong><span>Clinical workspace</span></div><Menu size={16} /></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><span>Chilin OT</span><ChevronRight size={14} /><strong>{navItems.find((item) => item.id === page)?.label}</strong></div>
          <div className="topbar-actions">
            <span className={`connection-pill ${health?.database === 'connected' ? 'connected' : ''}`}>
              <i />{health?.database === 'connected' ? 'Database connected' : loading ? 'Checking services' : 'Database unavailable'}
            </span>
            <div className="text-size-controls" role="group" aria-label="文字大小">
              <span><Type size={15} />文字</span>
              <button className="text-size-button" aria-label="縮小文字" title="縮小文字" disabled={textScale <= 85} onClick={() => setTextScale((scale) => Math.max(85, scale - 10))}><Minus size={16} /></button>
              <button className="text-size-button" aria-label="放大文字" title="放大文字" disabled={textScale >= 130} onClick={() => setTextScale((scale) => Math.min(130, scale + 10))}><Plus size={16} /></button>
            </div>
            <label className="date-picker"><CalendarDays size={16} /><input type="date" value={date} onChange={(event) => { setDate(event.target.value); setSelectedSession(null); setEnrollments([]) }} /></label>
          </div>
        </header>

        <div className="page-wrap">
          {error && <div className="notice error-notice"><AlertTriangle size={17} /><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}><X size={16} /></button></div>}
          {message && <div className="notice success-notice"><Check size={17} /><span>{message}</span><button aria-label="Dismiss message" onClick={() => setMessage('')}><X size={16} /></button></div>}
          {loading && !dashboard ? <div className="loading-state"><div className="spinner" />Connecting to the OT workspace…</div> : null}
          {!loading && !dashboard && !error ? <div className="empty-state">No dashboard data is available yet. Confirm the database schema is installed and refresh.</div> : null}

          {page === 'dashboard' && dashboard && (
            <DashboardPage
              dashboard={dashboard}
              onOpenSession={openSession}
              onGoToLogistics={() => setPage('logistics')}
              onGoToResidents={() => setPage('residents')}
            />
          )}

          {page === 'residents' && (
            <section>
              <PageTitle eyebrow="CLIENT RECORDS" title="Residents" subtitle="Manage resident information, assessment history, and dietary needs.">
                <button className="primary-button" onClick={() => setModal('resident')}><Plus size={17} /> Add resident</button>
              </PageTitle>
              <div className="split-layout residents-layout">
                <div className="panel resident-list-panel">
                  <div className="panel-toolbar">
                    <div className="search-box"><Search size={16} /><input placeholder="Search residents or rooms…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
                    <span className="muted small">{visibleResidents.length} residents</span>
                  </div>
                  <div className="resident-table">
                    <div className="table-heading"><span>RESIDENT</span><span>ROOM / BED</span><span>STATUS</span></div>
                    {visibleResidents.map((resident) => (
                      <button key={resident.resident_id} className={`resident-row ${selectedResident?.resident_id === resident.resident_id ? 'selected' : ''}`} onClick={() => openResident(resident)}>
                        <span className="resident-name"><span className="resident-avatar">{resident.name?.slice(0, 1)?.toUpperCase()}</span><span><strong>{resident.name}</strong><small>{resident.has_dementia ? 'Dementia care' : 'Resident'}</small></span></span>
                        <span className="room-cell">{resident.room_number}{resident.bed_number != null ? ` / ${resident.bed_number}` : ''}</span>
                        <span><StatusBadge value={resident.status} /></span>
                      </button>
                    ))}
                    {!visibleResidents.length && <div className="table-empty">No residents match your search.</div>}
                  </div>
                </div>
                <ResidentDetail
                  resident={selectedResident}
                  trend={residentTrend}
                  onAddProfile={() => setModal('profile')}
                  onAddDiet={() => setModal('diet')}
                  onEditResident={() => setModal('edit-resident')}
                  onEditProfile={() => setModal('edit-profile')}
                  onEditDiet={() => setModal('edit-diet')}
                />
              </div>
            </section>
          )}

          {page === 'schedule' && (
            <section>
              <PageTitle eyebrow="THERAPY PROGRAMMES" title="Session schedule" subtitle="Plan therapy groups and manage resident participation.">
                <button className="secondary-button" onClick={() => setModal('group')}><Plus size={16} /> New group</button>
                <button className="primary-button" onClick={() => setModal('session')}><Plus size={17} /> Schedule session</button>
              </PageTitle>
              <div className="schedule-summary">
                <div><span className="summary-icon purple"><CalendarDays size={18} /></span><span><small>Sessions on {date}</small><strong>{sessions.length}</strong></span></div>
                <div><span className="summary-icon green"><Users size={18} /></span><span><small>Therapy groups</small><strong>{groups.length}</strong></span></div>
                <div><span className="summary-icon amber"><MapPinIcon /></span><span><small>Locations in use</small><strong>{new Set(sessions.map((session) => session.location).filter(Boolean)).size}</strong></span></div>
              </div>
              <div className="session-grid">
                {sessions.map((session) => (
                  <SessionCard key={session.session_id} session={session} onOpen={() => openSession(session)} />
                ))}
                {!sessions.length && <div className="panel empty-sessions"><CalendarDays size={28} /><strong>No sessions scheduled</strong><span>Create a therapy session for this date to get started.</span><button className="secondary-button" onClick={() => setModal('session')}><Plus size={15} /> Schedule session</button></div>}
              </div>
            </section>
          )}

          {page === 'logistics' && (
            <LogisticsPage
              date={date}
              sessions={sessions}
              selectedSession={selectedSession}
              enrollments={enrollments}
              onSelectSession={openSession}
              onAddEnrollment={addEnrollment}
              onUpdateEnrollment={updateEnrollment}
            />
          )}

          {page === 'reports' && (
            <ReportsPage
              month={reportMonth}
              setMonth={setReportMonth}
              range={reportRange}
              setRange={setReportRange}
              engagement={engagement}
              onDownload={downloadReport}
              onLoadEngagement={loadEngagement}
            />
          )}
        </div>
      </main>

      {modal && (
        <Modal title={{
          resident: 'Add resident',
          'edit-resident': 'Edit resident',
          profile: `Add assessment${selectedResident ? ` · ${selectedResident.name}` : ''}`,
          'edit-profile': `Edit assessment${selectedResident ? ` · ${selectedResident.name}` : ''}`,
          diet: `Add dietary requirements${selectedResident ? ` · ${selectedResident.name}` : ''}`,
          'edit-diet': `Edit dietary requirements${selectedResident ? ` · ${selectedResident.name}` : ''}`,
          session: 'Schedule a session',
          group: 'Create a therapy group',
        }[modal]} onClose={() => setModal('')}>
          {modal === 'resident' && (
            <form onSubmit={(event) => {
              const form = new FormData(event.currentTarget)
              submitForm(event, '/residents', 'POST', {
                name: form.get('name'),
                room_number: form.get('room_number'),
                bed_number: form.get('bed_number') ? Number(form.get('bed_number')) : null,
                has_dementia: form.get('has_dementia') === 'on',
                requires_wheelchair: form.get('requires_wheelchair') === 'on',
                status: form.get('status'),
              }, 'Resident added.')
            }}>
              <div className="form-grid">
                <FormField label="Full name"><input name="name" required maxLength="160" /></FormField>
                <FormField label="Status"><select name="status"><option value="active">Active</option><option value="hospitalized">Hospitalized</option><option value="discharged">Discharged</option></select></FormField>
                <FormField label="Room number"><input name="room_number" required /></FormField>
                <FormField label="Bed number"><input name="bed_number" type="number" min="0" /></FormField>
              </div>
              <div className="checkbox-row"><label><input type="checkbox" name="has_dementia" /> Dementia care flag</label><label><input type="checkbox" name="requires_wheelchair" /> Requires wheelchair</label></div>
              <ModalActions onCancel={() => setModal('')} />
            </form>
          )}
          {modal === 'edit-resident' && selectedResident && (
            <form onSubmit={editResident}>
              <div className="form-grid">
                <FormField label="Full name"><input name="name" required maxLength="160" defaultValue={selectedResident.name} /></FormField>
                <FormField label="Status"><select name="status" defaultValue={selectedResident.status}><option value="active">Active</option><option value="hospitalized">Hospitalized</option><option value="discharged">Discharged</option></select></FormField>
                <FormField label="Room number"><input name="room_number" required defaultValue={selectedResident.room_number} /></FormField>
                <FormField label="Bed number"><input name="bed_number" type="number" min="0" defaultValue={selectedResident.bed_number ?? ''} /></FormField>
              </div>
              <div className="checkbox-row"><label><input type="checkbox" name="has_dementia" defaultChecked={selectedResident.has_dementia} /> Dementia care flag</label><label><input type="checkbox" name="requires_wheelchair" defaultChecked={selectedResident.requires_wheelchair} /> Requires wheelchair</label></div>
              <ModalActions onCancel={() => setModal('')} />
            </form>
          )}
          {modal === 'profile' && selectedResident && (
            <form onSubmit={(event) => {
              const form = new FormData(event.currentTarget)
              submitForm(event, `/residents/${selectedResident.resident_id}/clinical-profiles`, 'POST', {
                assessment_date: form.get('assessment_date'),
                hkbc_score: form.get('hkbc_score') ? Number(form.get('hkbc_score')) : null,
                moca_score: form.get('moca_score') ? Number(form.get('moca_score')) : null,
                restraint_status: form.get('restraint_status') || null,
                mental_health_notes: form.get('mental_health_notes') || null,
              }, 'Assessment saved.', false)
            }}>
              <div className="form-grid">
                <FormField label="Assessment date"><input name="assessment_date" type="date" defaultValue={today()} required /></FormField>
                <FormField label="MoCA score (0–30)"><input name="moca_score" type="number" min="0" max="30" /></FormField>
                <FormField label="HKBC score"><input name="hkbc_score" type="number" min="0" /></FormField>
                <FormField label="Restraint status"><input name="restraint_status" /></FormField>
                <FormField label="Mental health notes" wide><textarea name="mental_health_notes" rows="3" /></FormField>
              </div>
              <ModalActions onCancel={() => setModal('')} />
            </form>
          )}
          {modal === 'edit-profile' && selectedResident?.latest_profile && (
            <form onSubmit={(event) => {
              const form = new FormData(event.currentTarget)
              submitForm(event, `/residents/${selectedResident.resident_id}/clinical-profiles/latest`, 'PATCH', {
                assessment_date: form.get('assessment_date'),
                hkbc_score: form.get('hkbc_score') ? Number(form.get('hkbc_score')) : null,
                moca_score: form.get('moca_score') ? Number(form.get('moca_score')) : null,
                restraint_status: form.get('restraint_status') || null,
                mental_health_notes: form.get('mental_health_notes') || null,
              }, 'Assessment updated.')
            }}>
              <div className="form-grid">
                <FormField label="Assessment date"><input name="assessment_date" type="date" defaultValue={selectedResident.latest_profile.assessment_date} required /></FormField>
                <FormField label="MoCA score (0–30)"><input name="moca_score" type="number" min="0" max="30" defaultValue={selectedResident.latest_profile.moca_score ?? ''} /></FormField>
                <FormField label="HKBC score"><input name="hkbc_score" type="number" min="0" defaultValue={selectedResident.latest_profile.hkbc_score ?? ''} /></FormField>
                <FormField label="Restraint status"><input name="restraint_status" defaultValue={selectedResident.latest_profile.restraint_status ?? ''} /></FormField>
                <FormField label="Mental health notes" wide><textarea name="mental_health_notes" rows="3" defaultValue={selectedResident.latest_profile.mental_health_notes ?? ''} /></FormField>
              </div>
              <ModalActions onCancel={() => setModal('')} />
            </form>
          )}
          {modal === 'diet' && selectedResident && (
            <form onSubmit={(event) => {
              const form = new FormData(event.currentTarget)
              submitForm(event, `/residents/${selectedResident.resident_id}/dietary-requirements`, 'POST', {
                effective_date: form.get('effective_date'),
                food_texture: form.get('food_texture'),
                fluid_consistency: form.get('fluid_consistency'),
                food_allergies: form.get('food_allergies') || null,
                adaptive_equipment: form.get('adaptive_equipment') || null,
              }, 'Dietary requirements saved.', false)
            }}>
              <div className="form-grid">
                <FormField label="Effective date"><input name="effective_date" type="date" defaultValue={today()} required /></FormField>
                <FormField label="Food texture"><select name="food_texture"><option>Normal</option><option>Soft</option><option>Minced</option><option>Pureed</option></select></FormField>
                <FormField label="Fluid consistency"><select name="fluid_consistency"><option>Regular</option><option>Nectar</option><option>Honey</option><option>Pudding</option></select></FormField>
                <FormField label="Adaptive equipment"><input name="adaptive_equipment" placeholder="e.g. built-up handles" /></FormField>
                <FormField label="Food allergies" wide><textarea name="food_allergies" rows="2" placeholder="Document allergies or enter none" /></FormField>
              </div>
              <ModalActions onCancel={() => setModal('')} />
            </form>
          )}
          {modal === 'edit-diet' && selectedResident?.latest_diet && (
            <form onSubmit={(event) => {
              const form = new FormData(event.currentTarget)
              submitForm(event, `/dietary-requirements/${selectedResident.latest_diet.diet_id}`, 'PATCH', {
                effective_date: form.get('effective_date'),
                food_texture: form.get('food_texture'),
                fluid_consistency: form.get('fluid_consistency'),
                food_allergies: form.get('food_allergies') || null,
                adaptive_equipment: form.get('adaptive_equipment') || null,
              }, 'Dietary requirements updated.', false)
            }}>
              <div className="form-grid">
                <FormField label="Effective date"><input name="effective_date" type="date" defaultValue={selectedResident.latest_diet.effective_date} required /></FormField>
                <FormField label="Food texture"><select name="food_texture" defaultValue={selectedResident.latest_diet.food_texture}><option>Normal</option><option>Soft</option><option>Minced</option><option>Pureed</option></select></FormField>
                <FormField label="Fluid consistency"><select name="fluid_consistency" defaultValue={selectedResident.latest_diet.fluid_consistency}><option>Regular</option><option>Nectar</option><option>Honey</option><option>Pudding</option></select></FormField>
                <FormField label="Adaptive equipment"><input name="adaptive_equipment" defaultValue={selectedResident.latest_diet.adaptive_equipment ?? ''} /></FormField>
                <FormField label="Food allergies" wide><textarea name="food_allergies" rows="2" defaultValue={selectedResident.latest_diet.food_allergies ?? ''} /></FormField>
              </div>
              <ModalActions onCancel={() => setModal('')} />
            </form>
          )}
          {modal === 'group' && (
            <form onSubmit={(event) => {
              const form = new FormData(event.currentTarget)
              submitForm(event, '/therapy-groups', 'POST', {
                group_name: form.get('group_name'),
                group_code: form.get('group_code'),
                location: form.get('location'),
                description: form.get('description') || null,
              }, 'Therapy group created.')
            }}>
              <div className="form-grid">
                <FormField label="Group name"><input name="group_name" required /></FormField>
                <FormField label="Code"><input name="group_code" required /></FormField>
                <FormField label="Location"><input name="location" required /></FormField>
                <FormField label="Description"><input name="description" /></FormField>
              </div>
              <ModalActions onCancel={() => setModal('')} />
            </form>
          )}
          {modal === 'session' && (
            <form onSubmit={(event) => {
              const form = new FormData(event.currentTarget)
              submitForm(event, '/sessions', 'POST', {
                group_id: Number(form.get('group_id')),
                scheduled_date: form.get('scheduled_date'),
                start_time: form.get('start_time'),
                end_time: form.get('end_time'),
                therapist: form.get('therapist') || null,
                capacity: form.get('capacity') ? Number(form.get('capacity')) : null,
              }, 'Session scheduled.')
            }}>
              <div className="form-grid">
                <FormField label="Therapy group" wide><select name="group_id" required defaultValue=""><option value="" disabled>Select a group</option>{groups.map((group) => <option key={group.group_id} value={group.group_id}>{group.group_name} · {group.group_code}</option>)}</select></FormField>
                <FormField label="Date"><input name="scheduled_date" type="date" defaultValue={date} required /></FormField>
                <FormField label="Therapist"><input name="therapist" /></FormField>
                <FormField label="Start time"><input name="start_time" type="time" required /></FormField>
                <FormField label="End time"><input name="end_time" type="time" required /></FormField>
                <FormField label="Capacity"><input name="capacity" type="number" min="1" /></FormField>
              </div>
              {!groups.length && <p className="form-hint">Create a therapy group before scheduling a session.</p>}
              <ModalActions onCancel={() => setModal('')} disabled={!groups.length} />
            </form>
          )}
        </Modal>
      )}
    </div>
  )
}

function DashboardPage({ dashboard, onOpenSession, onGoToLogistics, onGoToResidents }) {
  return (
    <section>
      <PageTitle eyebrow="OVERVIEW" title="Good day, OT team" subtitle="Here’s your operational snapshot for today.">
        <span className="date-context"><CalendarDays size={16} />{new Date(`${dashboard.on_date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
      </PageTitle>
      <div className="stat-grid">
        <StatCard label="Active residents" value={dashboard.active_residents} detail="Residents in care" icon={Users} tone="violet" />
        <StatCard label="Groups today" value={dashboard.sessions_today} detail="Scheduled sessions" icon={CalendarDays} tone="blue" />
        <StatCard label="Participation" value={dashboard.residents_scheduled} detail="Residents scheduled" icon={HeartPulse} tone="green" />
        <StatCard label="Items to review" value={dashboard.transfers_pending + dashboard.dietary_alerts + dashboard.scheduling_conflicts + (dashboard.bed_occupancy_conflicts ?? 0)} detail="Bed, transfer, diet & schedule flags" icon={AlertTriangle} tone="amber" />
      </div>
      <div className="dashboard-columns">
        <div className="panel">
          <PanelHeading title="Today’s schedule" detail={`${dashboard.sessions.length} sessions`} action={<button className="text-button" onClick={onGoToLogistics}>Open logistics <ChevronRight size={15} /></button>} />
          {dashboard.sessions.length ? (
            <div className="schedule-list">{dashboard.sessions.map((session) => <SessionCard key={session.session_id} session={session} onOpen={() => onOpenSession(session)} compact />)}</div>
          ) : <EmptyBlock icon={CalendarDays} title="Nothing scheduled today" detail="Add a session to see it on your daily board." />}
        </div>
        <div className="panel">
          <PanelHeading title="Safety & logistics" detail={`${dashboard.alerts.length} alerts`} />
          {dashboard.alerts.length ? (
            <div className="alert-list">{dashboard.alerts.slice(0, 6).map((alert, index) => (
              <div className="alert-item" key={`${alert.type}-${index}`}>
                <span className={`alert-icon ${alert.type}`} >{alert.type === 'dietary' ? <Utensils size={16} /> : <AlertTriangle size={16} />}</span>
                <span><strong>{alert.resident}</strong><small>{alert.message}{alert.room_number ? ` · Room ${alert.room_number}` : ''}</small></span>
                <span className={`alert-tag ${alert.type}`}>{alert.type === 'bed_occupancy' ? 'BED' : alert.type === 'dietary' ? 'DIET' : alert.type === 'schedule' ? 'SCHEDULE' : 'TRANSFER'}</span>
              </div>
            ))}</div>
          ) : <EmptyBlock icon={ShieldCheck} title="All clear" detail="No bed occupancy, transfer, dietary, or scheduling alerts today." />}
        </div>
      </div>
      <div className="quick-actions">
        <button onClick={onGoToResidents}><span className="quick-icon"><Users size={18} /></span><span><strong>Resident records</strong><small>Assessments and care needs</small></span><ChevronRight size={17} /></button>
        <button onClick={onGoToLogistics}><span className="quick-icon peach"><ClipboardList size={18} /></span><span><strong>Transfer list</strong><small>Track resident movements</small></span><ChevronRight size={17} /></button>
      </div>
    </section>
  )
}

function LogisticsPage({ date, sessions, selectedSession, enrollments, onSelectSession, onAddEnrollment, onUpdateEnrollment }) {
  const [dementiaOnly, setDementiaOnly] = useState(false)
  const [mocaBelow, setMocaBelow] = useState('')
  const [candidates, setCandidates] = useState([])
  const [candidateError, setCandidateError] = useState('')

  useEffect(() => {
    if (!selectedSession) return
    let ignore = false
    const params = new URLSearchParams({ session_id: String(selectedSession.session_id) })
    if (dementiaOnly) params.set('has_dementia', 'true')
    if (mocaBelow) params.set('moca_below', mocaBelow)
    request(`/residents/candidates?${params}`)
      .then((data) => {
        if (!ignore) {
          setCandidates(data)
          setCandidateError('')
        }
      })
      .catch((requestError) => {
        if (!ignore) setCandidateError(requestError.message)
      })
    return () => { ignore = true }
  }, [selectedSession, dementiaOnly, mocaBelow, enrollments])

  return (
    <section>
      <PageTitle eyebrow="FLOOR OPERATIONS" title="Transfer & attendance" subtitle="Tablet-friendly session lists for resident transport and attendance." />
      <div className="logistics-layout">
        <div className="panel logistics-sessions">
          <PanelHeading title="Sessions" detail={date} />
          {sessions.map((session) => (
            <button key={session.session_id} className={`logistics-session ${selectedSession?.session_id === session.session_id ? 'selected' : ''}`} onClick={() => onSelectSession(session)}>
              <span className="session-time">{String(session.start_time).slice(0, 5)}</span>
              <span><strong>{session.group_name}</strong><small>{session.location || 'Location not set'}</small></span>
              <ChevronRight size={16} />
            </button>
          ))}
          {!sessions.length && <div className="small-empty">No sessions for this date.</div>}
        </div>
        <div className="panel logistics-board">
          {selectedSession ? (
            <>
              <PanelHeading title={selectedSession.group_name} detail={`${String(selectedSession.start_time).slice(0, 5)} · ${selectedSession.location || 'Location TBD'}`} />
              <div className="candidate-filters">
                <span>Candidate filters</span>
                <label><input type="checkbox" checked={dementiaOnly} onChange={(event) => setDementiaOnly(event.target.checked)} /> Dementia care</label>
                <label>MoCA below <input aria-label="MoCA score threshold" type="number" min="1" max="30" placeholder="—" value={mocaBelow} onChange={(event) => setMocaBelow(event.target.value)} /></label>
                <small>{candidates.length} eligible residents</small>
              </div>
              {candidateError && <p className="candidate-error">{candidateError}</p>}
              <form className="add-enrollment" onSubmit={onAddEnrollment}>
                <select name="resident_id" required defaultValue=""><option value="" disabled>Add resident to session…</option>{candidates.map((resident) => <option key={resident.resident_id} value={resident.resident_id}>{resident.name} · Room {resident.room_number}{resident.latest_moca_score != null ? ` · MoCA ${resident.latest_moca_score}` : ''}</option>)}</select>
                <select name="transfer_type" aria-label="Transfer type"><option value="無">No transfer</option><option value="落人">落人</option><option value="PT過OT">PT過OT</option><option value="OT過PT">OT過PT</option></select>
                <button className="primary-button" type="submit" disabled={!candidates.length}><Plus size={15} /> Add</button>
              </form>
              <div className="logistics-table">
                <div className="logistics-head"><span>RESIDENT / ROOM</span><span>TRANSFER</span><span>ATTENDANCE</span><span /></div>
                {enrollments.map((entry) => (
                  <div className="logistics-row" key={entry.enrollment_id}>
                    <span className="logistics-resident">
                      <strong>{entry.name}</strong>
                      <small>Room {entry.room_number}{entry.bed_number != null ? ` · Bed ${entry.bed_number}` : ''}{entry.requires_wheelchair ? ' · Wheelchair' : ''}</small>
                      <input className="performance-note-input" aria-label={`Performance notes for ${entry.name}`} defaultValue={entry.performance_notes || ''} placeholder="Add performance note…" onBlur={(event) => { if (event.target.value !== (entry.performance_notes || '')) onUpdateEnrollment(entry.enrollment_id, { performance_notes: event.target.value }) }} />
                    </span>
                    <span className="transfer-cell">
                      <select value={entry.transfer_type} onChange={(event) => onUpdateEnrollment(entry.enrollment_id, { transfer_type: event.target.value })} aria-label={`Transfer type for ${entry.name}`}>
                        <option value="無">None</option><option value="落人">落人</option><option value="PT過OT">PT過OT</option><option value="OT過PT">OT過PT</option>
                      </select>
                      {entry.transfer_type !== '無' && <button className={`transfer-toggle ${entry.transfer_status === 'completed' ? 'done' : ''}`} onClick={() => onUpdateEnrollment(entry.enrollment_id, { transfer_status: entry.transfer_status === 'pending' ? 'in_progress' : entry.transfer_status === 'in_progress' ? 'completed' : 'pending' })}>{entry.transfer_status === 'completed' ? <><Check size={13} /> Done</> : entry.transfer_status === 'in_progress' ? 'Complete transfer' : 'Start transfer'}</button>}
                    </span>
                    <select className="attendance-select" value={entry.attendance_status} onChange={(event) => onUpdateEnrollment(entry.enrollment_id, { attendance_status: event.target.value })} aria-label={`Attendance for ${entry.name}`}>
                      <option value="scheduled">Scheduled</option><option value="attended">Attended</option><option value="absent">Absent</option><option value="refused">Refused</option>
                    </select>
                    {entry.requires_wheelchair ? <Accessibility size={17} className="wheelchair-icon" /> : <span />}
                  </div>
                ))}
                {!enrollments.length && <div className="table-empty">No residents enrolled in this session.</div>}
              </div>
            </>
          ) : <EmptyBlock icon={ClipboardList} title="Choose a session" detail="Select a session to view its transfer list and attendance." />}
        </div>
      </div>
    </section>
  )
}

function ReportsPage({ month, setMonth, range, setRange, engagement, onDownload, onLoadEngagement }) {
  return (
    <section>
      <PageTitle eyebrow="INSIGHTS & EXPORTS" title="Reports" subtitle="Review participation and export monthly OT treatment records." />
      <div className="report-grid">
        <div className="panel report-card">
          <span className="report-icon blue"><Activity size={20} /></span>
          <h2>Engagement report</h2>
          <p>Measure attendance across a selected date range.</p>
          <form onSubmit={onLoadEngagement} className="report-form">
            <FormField label="From"><input type="date" value={range.start} onChange={(event) => setRange({ ...range, start: event.target.value })} required /></FormField>
            <FormField label="To"><input type="date" value={range.end} onChange={(event) => setRange({ ...range, end: event.target.value })} required /></FormField>
            <button className="primary-button" type="submit">Generate report</button>
          </form>
          {engagement && <div className="engagement-result">
            <div><span>Attendance rate</span><strong>{engagement.attendance_rate}%</strong></div>
            <div><span>Attended / enrolled</span><strong>{engagement.attended} / {engagement.enrollments}</strong></div>
            <div><span>Sessions included</span><strong>{engagement.sessions}</strong></div>
          </div>}
        </div>
        <div className="panel report-card">
          <span className="report-icon green"><ArrowDownToLine size={20} /></span>
          <h2>Monthly treatment record</h2>
          <p>Export session, attendance, transfer, and performance-note data as a CSV file.</p>
          <div className="report-form single">
            <FormField label="Report month"><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></FormField>
            <button className="primary-button" onClick={onDownload}><ArrowDownToLine size={16} /> Download CSV</button>
          </div>
          <div className="privacy-hint"><ShieldCheck size={15} /> Exports are generated by the backend and use your configured database.</div>
        </div>
      </div>
      <div className="panel trend-info">
        <div className="trend-info-icon"><HeartPulse size={19} /></div>
        <div><strong>Longitudinal assessment trends</strong><p>Open a resident record to review up to five years of HKBC and MoCA assessment history.</p></div>
      </div>
    </section>
  )
}

function ResidentDetail({ resident, trend, onAddProfile, onAddDiet, onEditResident, onEditProfile, onEditDiet }) {
  if (!resident) return <div className="panel resident-detail empty-detail"><Users size={25} /><strong>Select a resident</strong><span>Choose a record to review assessments and care needs.</span></div>
  return (
    <div className="panel resident-detail">
      <div className="detail-header">
        <div className="detail-avatar">{resident.name?.slice(0, 1)?.toUpperCase()}</div>
        <div><h2>{resident.name}</h2><p>Room {resident.room_number}{resident.bed_number != null ? ` · Bed ${resident.bed_number}` : ''}</p></div>
        <button className="icon-button" onClick={onEditResident} aria-label="Edit resident details" title="Edit resident details"><Pencil size={16} /></button>
        <StatusBadge value={resident.status} />
      </div>
      <div className="resident-flags">{resident.has_dementia && <span className="flag purple">Dementia care</span>}{resident.requires_wheelchair && <span className="flag blue"><Accessibility size={13} /> Wheelchair</span>}{!resident.has_dementia && !resident.requires_wheelchair && <span className="muted small">No care flags</span>}</div>
      <div className="detail-section">
        <div className="section-title"><span><Users size={16} /> Cognitive group sign-ups</span></div>
        {resident.cognitive_groups?.length ? (
          <div className="cognitive-group-list">
            {resident.cognitive_groups.map((group) => (
              <div className="cognitive-group-item" key={group.session_id}>
                <strong>{group.group_name || 'Therapy group'}</strong>
                <span>{group.group_code}</span>
                <small>{group.scheduled_date} · {String(group.start_time).slice(0, 5)} · Therapist: {group.therapist || 'Not listed'}</small>
              </div>
            ))}
          </div>
        ) : <p className="muted small">None</p>}
      </div>
      <div className="detail-section">
        <div className="section-title"><span><HeartPulse size={16} /> Latest clinical profile</span><span className="section-actions">{resident.latest_profile && <button className="icon-button" onClick={onEditProfile} aria-label="Edit latest assessment" title="Edit latest assessment"><Pencil size={14} /></button>}<button className="text-button" onClick={onAddProfile}><Plus size={14} /> Add</button></span></div>
        {resident.latest_profile ? (
          <div className="clinical-summary">
            <div><small>Assessment date</small><strong>{resident.latest_profile.assessment_date}</strong></div>
            <div><small>MoCA</small><strong>{resident.latest_profile.moca_score ?? '—'}<em> / 30</em></strong></div>
            <div><small>HKBC</small><strong>{resident.latest_profile.hkbc_score ?? '—'}</strong></div>
            {resident.latest_profile.restraint_status && <p className="detail-note">Restraint: {resident.latest_profile.restraint_status}</p>}
            {resident.latest_profile.mental_health_notes && <p className="detail-note">{resident.latest_profile.mental_health_notes}</p>}
          </div>
        ) : <p className="muted small">No assessment has been recorded.</p>}
      </div>
      <div className="detail-section">
        <div className="section-title"><span><Utensils size={16} /> Dietary requirements</span><span className="section-actions">{resident.latest_diet && <button className="icon-button" onClick={onEditDiet} aria-label="Edit latest dietary requirements" title="Edit latest dietary requirements"><Pencil size={14} /></button>}<button className="text-button" onClick={onAddDiet}><Plus size={14} /> Add</button></span></div>
        {resident.latest_diet ? (
          <div className="diet-summary">
            <div className="diet-tags"><span>{resident.latest_diet.food_texture} texture</span><span>{resident.latest_diet.fluid_consistency} fluids</span></div>
            <small>Effective {resident.latest_diet.effective_date}</small>
            {resident.latest_diet.food_allergies && <p className="allergy-note"><AlertTriangle size={14} /> Allergies: {resident.latest_diet.food_allergies}</p>}
            {resident.latest_diet.adaptive_equipment && <p className="detail-note">Equipment: {resident.latest_diet.adaptive_equipment}</p>}
          </div>
        ) : <p className="muted small">No dietary requirements on file.</p>}
      </div>
      <div className="detail-section trend-section">
        <div className="section-title"><span><Activity size={16} /> Assessment trend</span><span className="muted tiny">5 years</span></div>
        {trend.some((point) => point.moca_score != null || point.hkbc_score != null) ? (
          <div className="trend-charts">
            <TrendChart points={trend} scoreKey="moca_score" label="MoCA" maxScore={30} />
            <TrendChart points={trend} scoreKey="hkbc_score" label="HKBC" />
          </div>
        ) : <p className="muted small">Add assessment scores to build a longitudinal trend.</p>}
      </div>
    </div>
  )
}

function TrendChart({ points, scoreKey, label, maxScore }) {
  const scored = points.filter((point) => point[scoreKey] != null)
  const scoreMaximum = maxScore ?? Math.max(...scored.map((point) => Number(point[scoreKey])), 1)
  const coords = scored.map((point, index) => ({
    x: scored.length === 1 ? 50 : 8 + (index / (scored.length - 1)) * 84,
    y: 82 - (Number(point[scoreKey]) / scoreMaximum) * 70,
    ...point,
  }))
  const line = coords.map((point) => `${point.x},${point.y}`).join(' ')
  return <div className={`chart-wrap ${scoreKey}`}>
    {scored.length ? <svg viewBox="0 0 100 90" role="img" aria-label={`${label} scores over time`}>
      {[12, 35, 58, 82].map((y) => <line key={y} x1="5" x2="95" y1={y} y2={y} className="chart-grid" />)}
      {coords.length > 1 && <polyline points={line} className="chart-line" />}
      {coords.map((point) => <circle key={`${point.assessment_date}-${point.x}`} cx={point.x} cy={point.y} r="2.2" className="chart-point"><title>{point.assessment_date}: {point[scoreKey]}</title></circle>)}
    </svg> : <div className="chart-empty">No {label} scores recorded.</div>}
    <div className="chart-caption"><strong>{label} score</strong><span>{scored.length ? `${scored[0].assessment_date} — ${scored.at(-1).assessment_date}` : 'No scores recorded'}</span></div>
  </div>
}

function SessionCard({ session, onOpen, compact = false }) {
  return (
    <button className={`session-card ${compact ? 'compact' : ''}`} onClick={onOpen}>
      <div className="session-card-top"><span className="session-code">{session.group_code || 'OT'}</span><span className="session-clock"><Clock3 size={14} />{String(session.start_time).slice(0, 5)}–{String(session.end_time).slice(0, 5)}</span></div>
      <strong>{session.group_name}</strong>
      <span className="session-location">{session.location || 'Location not set'}{session.therapist ? ` · ${session.therapist}` : ''}</span>
      <span className="session-card-bottom"><span><Users size={14} /> {session.enrollment_count ?? 'Manage'} residents</span><ChevronRight size={16} /></span>
    </button>
  )
}

function PageTitle({ eyebrow, title, subtitle, children }) {
  return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{subtitle}</p></div><div className="page-actions">{children}</div></div>
}

function StatCard({ label, value, detail, icon, tone }) {
  const Icon = icon
  return <div className="stat-card"><span className={`stat-icon ${tone}`}><Icon size={19} /></span><span className="stat-copy"><small>{label}</small><strong>{value}</strong><em>{detail}</em></span></div>
}

function PanelHeading({ title, detail, action }) {
  return <div className="panel-heading"><div><h2>{title}</h2>{detail && <span>{detail}</span>}</div>{action}</div>
}

function EmptyBlock({ icon, title, detail }) {
  const Icon = icon
  return <div className="empty-block"><span><Icon size={20} /></span><strong>{title}</strong><small>{detail}</small></div>
}

function StatusBadge({ value }) {
  return <span className={`status-badge ${value}`}>{value}</span>
}

function Modal({ title, onClose, children }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>
      <div className="modal-content">{children}</div>
    </div>
  </div>
}

function FormField({ label, wide = false, children }) {
  return <label className={`form-field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}</label>
}

function ModalActions({ onCancel, disabled = false }) {
  return <div className="modal-actions"><button type="button" className="secondary-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-button" disabled={disabled}>Save record</button></div>
}

function MapPinIcon() {
  return <span className="pin-dot">⌖</span>
}

export default App

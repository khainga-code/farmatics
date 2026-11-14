import { Link } from 'react-router-dom';
import {
  batchHealth,
  groupMortalityByCause,
  toDateOnly,
  vaccinationCompliance,
  type DoseCompliance,
} from '@farmatics/shared';
import { AppLayout } from '../components/AppLayout.js';
import { Alert, Badge } from '../components/ui.js';
import { toBatches, toHouses, toMortality, toVaccinations, useFarmData } from '../local.js';
import { formatDate } from './PoultryPage.js';

/**
 * Health monitoring.
 *
 * The farm's losses and vaccination cover, derived from the events already on
 * the phone. Nothing here is stored as a rate or a status: the same records
 * produce the same figures on every phone, online or off.
 */

const DOSE_LABELS: Record<DoseCompliance, string> = {
  on_time: 'On time',
  late: 'Late',
  pending: 'Due',
  overdue: 'Overdue',
};

const DOSE_TONES: Record<DoseCompliance, 'neutral' | 'green' | 'amber' | 'red'> = {
  on_time: 'green',
  late: 'amber',
  pending: 'neutral',
  overdue: 'red',
};

export function HealthPage() {
  const { data, loading } = useFarmData();
  const today = toDateOnly(new Date());

  const houses = toHouses(data.houses);
  const mortality = toMortality(data.mortality_events);
  const vaccinations = toVaccinations(data.vaccination_events);

  const cards = toBatches(data.batches)
    .filter((batch) => batch.status === 'active')
    .map((batch) => {
      const events = mortality.filter((event) => event.batchId === batch.id);
      return {
        batch,
        house: houses.find((house) => house.id === batch.houseId)?.name ?? 'No house',
        health: batchHealth({
          arrivalDate: batch.arrivalDate,
          initialCount: batch.initialCount,
          mortality: events,
          today,
        }),
        compliance: vaccinationCompliance(
          batch.arrivalDate,
          vaccinations
            .filter((event) => event.batchId === batch.id)
            .map((event) => ({ day: event.day, recordedAt: event.recordedAt })),
          today,
        ),
        causes: groupMortalityByCause(events),
      };
    })
    .sort(
      (left, right) =>
        Number(right.health.alert === 'alert') - Number(left.health.alert === 'alert') ||
        right.health.deaths - left.health.deaths,
    );

  const alerts = cards.filter((card) => card.health.alert === 'alert');

  return (
    <AppLayout
      title="Health"
      subtitle="Losses, survival and vaccination cover, worked out from the flock's records"
    >
      {loading && <p className="muted">Loading this phone’s records…</p>}

      {!loading && cards.length === 0 && (
        <div className="card">
          <div className="card-body">
            <p className="muted">No active batches. Health figures appear once a batch arrives.</p>
          </div>
        </div>
      )}

      {!loading && cards.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2 className="card-title">Needs attention</h2>
            <Badge tone={alerts.length > 0 ? 'red' : 'green'}>
              {alerts.length > 0 ? `${alerts.length} batch${alerts.length === 1 ? '' : 'es'}` : 'All within limits'}
            </Badge>
          </div>
          <div className="card-body">
            {alerts.length === 0 ? (
              <Alert tone="success">
                No batch has crossed the first-week or cumulative mortality limits.
              </Alert>
            ) : (
              <ul className="list">
                {alerts.map((card) => (
                  <li className="list-item" key={card.batch.id}>
                    <div>
                      <div className="list-title">
                        <Link to={`/poultry/${card.batch.id}`}>{card.batch.code}</Link>
                      </div>
                      <div className="list-sub">{card.health.reasons.join(' ')}</div>
                    </div>
                    <Badge tone="red">{card.health.mortalityRatePct}% lost</Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {cards.map((card) => (
        <div className="card" key={card.batch.id}>
          <div className="card-head">
            <div>
              <h2 className="card-title">
                <Link to={`/poultry/${card.batch.id}`}>{card.batch.code}</Link>
                <span className="muted"> · {card.house}</span>
              </h2>
              <p className="list-sub">Arrived {formatDate(card.batch.arrivalDate)}</p>
            </div>
            <Badge tone={card.health.alert === 'alert' ? 'red' : 'green'}>
              {card.health.alert === 'alert' ? 'Check the flock' : 'On track'}
            </Badge>
          </div>
          <div className="card-body">
            <div className="status-grid">
              <div>
                <div className="status-label">Deaths</div>
                <div className="status-value">{card.health.deaths}</div>
              </div>
              <div>
                <div className="status-label">First week</div>
                <div className="status-value">{card.health.deathsFirstWeek}</div>
                <div className="list-sub">{card.health.firstWeekRatePct}% of arrival</div>
              </div>
              <div>
                <div className="status-label">Last 7 days</div>
                <div className="status-value">{card.health.deathsLast7Days}</div>
              </div>
              <div>
                <div className="status-label">Mortality</div>
                <div className="status-value">{card.health.mortalityRatePct}%</div>
              </div>
              <div>
                <div className="status-label">Surviving</div>
                <div className="status-value">{card.health.survivalRatePct}%</div>
              </div>
            </div>

            <div>
              <div className="status-label">Vaccinations</div>
              <ul className="list">
                {card.compliance.doses.map((status) => (
                  <li className="list-item" key={status.dose.day}>
                    <div>
                      <div className="list-title">{status.dose.label}</div>
                      <div className="list-sub">
                        Due {formatDate(status.dose.dueOn)}
                        {status.doneOn ? ` · recorded ${formatDate(status.doneOn)}` : ''}
                      </div>
                    </div>
                    <Badge tone={DOSE_TONES[status.state]}>{DOSE_LABELS[status.state]}</Badge>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <div className="status-label">What is killing birds</div>
              {card.causes.length === 0 ? (
                <p className="muted">No deaths recorded.</p>
              ) : (
                <div className="chips">
                  {card.causes.map((cause) => (
                    <span className="chip" key={cause.category ?? 'uncategorised'}>
                      {cause.label}: {cause.birds}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}
    </AppLayout>
  );
}

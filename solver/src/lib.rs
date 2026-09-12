//! Steady-state hydronic (water heating) network solver.
//!
//! Exposes a single wasm-bindgen entry point `solve(request_json) -> result_json`.
//!
//! The network is modelled at the **port level**, mirroring the TypeScript
//! reference solver (`app/src/solver/tsSolver.ts`) field-for-field:
//!
//! * Pressure nodes are PORTS, keyed `"${nodeId}:${portId}"`.
//! * External pipe edges connect two ports with Darcy resistance K
//!   (`dP = K·Q·|Q|`, Q in m³/s).
//! * Each component contributes INTERNAL branches between its own ports. A pump
//!   is a *node* with ports `in`/`out`; its head is applied on the internal
//!   `in→out` branch — never on external pipe edges. This is the crucial fix
//!   over the previous node-level model, which mis-applied pump head to pipes
//!   and so failed on systems with several pumps + a separator/buffer junction
//!   (secondary loops came out below ambient).
//!
//! After the linear-theory hydraulic solve fixes every branch flow, a
//! Gauss-Seidel thermal sweep mixes, at each node, the temperatures arriving at
//! its INFLOW ports and applies the role rule (source heats, emitter sheds to a
//! room, tank/junction/manifold mixes and feeds the mix to every outlet, …).
//!
//! All JSON field naming follows the TypeScript contract via
//! `#[serde(rename_all = "camelCase")]`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

// ---------------------------------------------------------------------------
// JSON contract types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveRequest {
    #[serde(default)]
    pub nodes: Vec<NodeReq>,
    #[serde(default)]
    pub edges: Vec<EdgeReq>,
    #[serde(default)]
    pub fluid: Fluid,
    #[serde(default)]
    pub ambient_c: f64,
    #[serde(default)]
    pub mode: String,
    /// Sealed-system static-pressure inputs distilled from the graph (fill valve +
    /// expansion vessel). Absent in hand-built requests -> sensible defaults.
    #[serde(default)]
    pub pressure: Option<PressureCfg>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PressureCfg {
    #[serde(default)]
    pub fill_kpa: f64,
    #[serde(default)]
    pub vessel_l: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeReq {
    pub id: String,
    /// Component role. Deserialized straight into the `Role` enum: a known role
    /// string maps to its variant, an unknown one is a serde error (fail fast),
    /// and a missing field defaults to `Role::Passive` via `#[serde(default)]`.
    #[serde(default)]
    pub role: Role,
    #[serde(default)]
    pub params: HashMap<String, f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeReq {
    pub id: String,
    pub from: String,
    #[serde(default)]
    pub from_port: String,
    pub to: String,
    #[serde(default)]
    pub to_port: String,
    #[serde(default = "default_line")]
    pub line: String,
    #[serde(default)]
    pub length_m: f64,
    #[serde(default)]
    pub diameter_mm: f64,
}

fn default_line() -> String {
    "auto".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fluid {
    #[serde(default = "default_cp")]
    pub cp_jkg_k: f64,
    #[serde(default = "default_rho")]
    pub rho_kg_m3: f64,
}

fn default_cp() -> f64 {
    4186.0
}
fn default_rho() -> f64 {
    997.0
}

impl Default for Fluid {
    fn default() -> Self {
        Fluid {
            cp_jkg_k: default_cp(),
            rho_kg_m3: default_rho(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveResult {
    pub status: String,
    pub iterations: u32,
    pub residual: f64,
    pub elapsed_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub global: GlobalResult,
    pub edges: HashMap<String, EdgeResult>,
    pub nodes: HashMap<String, NodeResult>,
    pub history: Vec<HistoryEntry>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GlobalResult {
    pub flow_m3h: f64,
    pub head_kpa: f64,
    pub pressure_kpa: f64,
    pub supply_c: f64,
    pub return_c: f64,
    pub delta_c: f64,
    pub heat_kw: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cop: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeResult {
    pub flow_m3h: f64,
    pub temp_c: f64,
    pub line: String,
    /// flow direction along the drawn edge (source->target): +1 fwd, -1 rev, 0 none
    pub dir: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heat_kw: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supply_c: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub return_c: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub valve_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cop: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strat: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub iter: u32,
    pub supply_c: f64,
    pub return_c: f64,
    pub heat_kw: f64,
}

// ---------------------------------------------------------------------------
// Internal working structures
// ---------------------------------------------------------------------------

/// Component thermal/hydraulic role.
///
/// Deserialized DIRECTLY from the JSON `role` string via serde
/// (`rename_all = "lowercase"`), so each known role maps to its lowercase name
/// ("source", "pump", …). An UNKNOWN role string is rejected by serde as an
/// unknown variant — there is deliberately no `#[serde(other)]` catch-all — so
/// the whole request fails to deserialize and `solve()` returns `status:"error"`
/// (fail fast). The JS worker then falls back to the trusted TS engine instead
/// of silently mis-solving an unrecognized component as `Passive`.
///
/// `Default` is `Passive` so a node with NO `role` field (the `#[serde(default)]`
/// on `NodeReq::role`) still behaves as a passive body, preserving prior
/// behaviour for an absent — but not an unrecognized — role.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Source,
    Pump,
    Emitter,
    Tank,
    Junction,
    Manifold,
    Valve,
    Group,
    #[default]
    Passive,
}

struct Node {
    id: String,
    role: Role,
    params: HashMap<String, f64>,
}

impl Node {
    fn p(&self, key: &str, default: f64) -> f64 {
        self.params.get(key).copied().unwrap_or(default)
    }
    fn has(&self, key: &str) -> bool {
        self.params.contains_key(key)
    }
}

/// A hydraulic branch between two port-nodes. `dP = k·Q·|Q|`. A pump adds head
/// `H(Q) = pump_h0·(1 − (Q/pump_qmax)²)` clamped ≥ 0 along the a→b direction.
struct Branch {
    a: usize, // port-node index
    b: usize,
    k: f64,
    pump_h0: f64,            // shutoff head [Pa]; 0 if not a pump branch
    pump_qmax: f64,          // [m³/s]
    q: f64,                  // solved flow a->b [m³/s]
    edge_id: Option<String>, // Some(id) for external pipe branches
}

const F_DARCY: f64 = 0.022;
const QREF_M3S: f64 = 1.0 / 3600.0; // 1 m³/h in m³/s, used for minor-loss K scaling
const Q_FLOOR: f64 = 1e-5; // linearization floor on |Q|

/// Base Darcy-Weisbach K for a pipe: `ΔP = K·Q·|Q|`, Q in m³/s.
/// Mirrors tsSolver `pipeK`: diameter floored at 5 mm, length at 0.1 m.
fn pipe_k(length_m: f64, diameter_mm: f64, rho: f64) -> f64 {
    let d_m = diameter_mm.max(5.0) / 1000.0;
    let area = std::f64::consts::PI * d_m * d_m / 4.0;
    let l = length_m.max(0.1);
    F_DARCY * (l / d_m) * 0.5 * rho / (area * area)
}

/// Minor loss given as a kPa drop at 1 m³/h reference flow. `K = (kKpa·1000)/Qref²`.
/// Mirrors tsSolver `minorK` (note: no zero short-circuit — a 0 here is fine
/// because every internal branch K is floored to ≥ 1 by `k_floor`).
fn minor_k(k_kpa: f64) -> f64 {
    (k_kpa * 1000.0) / (QREF_M3S * QREF_M3S)
}

/// Internal-branch K floor (tsSolver `k = (kk) => Math.max(kk, 1)`).
fn k_floor(kk: f64) -> f64 {
    kk.max(1.0)
}

// ---------------------------------------------------------------------------
// Linear system solver (small dense Gauss elimination with partial pivoting)
// ---------------------------------------------------------------------------

/// Solve A·x = b in place (b becomes x). Returns false if the system is singular.
fn gauss_solve(a: &mut [Vec<f64>], b: &mut [f64], n: usize) -> bool {
    for col in 0..n {
        // partial pivot
        let mut piv = col;
        let mut best = a[col][col].abs();
        for r in (col + 1)..n {
            let v = a[r][col].abs();
            if v > best {
                best = v;
                piv = r;
            }
        }
        if best < 1e-14 {
            return false; // singular
        }
        if piv != col {
            a.swap(piv, col);
            b.swap(piv, col);
        }
        let diag = a[col][col];
        for r in (col + 1)..n {
            let factor = a[r][col] / diag;
            if factor == 0.0 {
                continue;
            }
            for c in col..n {
                a[r][c] -= factor * a[col][c];
            }
            b[r] -= factor * b[col];
        }
    }
    // back substitution
    for col in (0..n).rev() {
        let mut sum = b[col];
        for c in (col + 1)..n {
            sum -= a[col][c] * b[c];
        }
        b[col] = sum / a[col][col];
    }
    true
}

// ---------------------------------------------------------------------------
// Network: port-level pressure model
// ---------------------------------------------------------------------------

struct Network {
    nodes: Vec<Node>,
    branches: Vec<Branch>,
    /// port index -> owning node index
    port_owner: Vec<usize>,
    /// node index -> the port indices owned by that node (deduplicated)
    node_ports: Vec<Vec<usize>>,
    /// `"${nodeId}:${portId}"` -> port index (mirrors tsSolver `portIndex`);
    /// used to look up a component's specific named ports (e.g. a group's
    /// pri_in/sec_in) during the thermal sweep.
    port_index: HashMap<String, usize>,
    /// `"${nodeId}:${portId}"` -> pipe line at that port (mirrors tsSolver
    /// `portLine`). Used to stratify a buffer tank: supply-side ports are the
    /// hot top, return-side ports the cool bottom. `'auto'` counts as supply.
    port_line: HashMap<String, PortLine>,
    fluid: Fluid,
    ambient_c: f64,
}

/// Side of a pipe at a tank port (mirrors tsSolver's `'supply' | 'return'`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum PortLine {
    Supply,
    Return,
}

struct NetworkBuilder {
    port_index: HashMap<String, usize>,
    port_owner: Vec<usize>,
    node_ports: Vec<Vec<usize>>,
}

impl NetworkBuilder {
    fn new(n_nodes: usize) -> Self {
        NetworkBuilder {
            port_index: HashMap::new(),
            port_owner: Vec::new(),
            node_ports: vec![Vec::new(); n_nodes],
        }
    }

    /// Return the port-node index for `${node_id}:${port_id}`, creating it (owned
    /// by `node_idx`) on first use. Also records the index against the node's
    /// port list (deduplicated) so the thermal sweep can iterate a node's ports.
    fn ensure(&mut self, node_idx: usize, node_id: &str, port_id: &str) -> usize {
        let key = format!("{}:{}", node_id, port_id);
        if let Some(&idx) = self.port_index.get(&key) {
            return idx;
        }
        let idx = self.port_owner.len();
        self.port_index.insert(key, idx);
        self.port_owner.push(node_idx);
        self.node_ports[node_idx].push(idx);
        idx
    }
}

fn build_network(req: &SolveRequest) -> Result<Network, String> {
    let fluid = Fluid {
        cp_jkg_k: if req.fluid.cp_jkg_k > 0.0 {
            req.fluid.cp_jkg_k
        } else {
            default_cp()
        },
        rho_kg_m3: if req.fluid.rho_kg_m3 > 0.0 {
            req.fluid.rho_kg_m3
        } else {
            default_rho()
        },
    };
    let rho = fluid.rho_kg_m3;

    let mut index: HashMap<String, usize> = HashMap::new();
    let mut nodes: Vec<Node> = Vec::with_capacity(req.nodes.len());
    for nr in &req.nodes {
        if index.contains_key(&nr.id) {
            return Err(format!("duplicate node id: {}", nr.id));
        }
        index.insert(nr.id.clone(), nodes.len());
        nodes.push(Node {
            id: nr.id.clone(),
            role: nr.role,
            params: nr.params.clone(),
        });
    }

    let mut nb = NetworkBuilder::new(nodes.len());
    let mut branches: Vec<Branch> = Vec::new();

    // ports actually used by each node (from edges) — lets tank/junction stars
    // and passive bodies wire whatever ports an instance has (configurable
    // tappings, fittings, …) with no hard-coded per-role list. Mirrors tsSolver.
    let mut node_port_ids: HashMap<String, Vec<String>> = HashMap::new();
    for er in &req.edges {
        let ef = node_port_ids.entry(er.from.clone()).or_default();
        if !ef.contains(&er.from_port) {
            ef.push(er.from_port.clone());
        }
        let et = node_port_ids.entry(er.to.clone()).or_default();
        if !et.contains(&er.to_port) {
            et.push(er.to_port.clone());
        }
    }
    let empty_ports: Vec<String> = Vec::new();

    // line (supply=hot/top, return=cool/bottom) of the pipe at each port — used
    // to stratify tanks: supply ports are the top, return ports the bottom.
    // Mirrors tsSolver `portLine` ('auto' counts as supply).
    let mut port_line: HashMap<String, PortLine> = HashMap::new();
    for er in &req.edges {
        let ln = if er.line == "return" {
            PortLine::Return
        } else {
            PortLine::Supply
        };
        port_line.insert(format!("{}:{}", er.from, er.from_port), ln);
        port_line.insert(format!("{}:{}", er.to, er.to_port), ln);
    }

    // ---- internal component branches (mirrors tsSolver solveInner) ----
    for (ni, node) in nodes.iter().enumerate() {
        match node.role {
            Role::Pump => {
                let a = nb.ensure(ni, &node.id, "in");
                let b = nb.ensure(ni, &node.id, "out");
                let h0 = node.p("h0Kpa", 40.0) * 1000.0;
                let qmax = (node.p("qMaxM3h", 3.0) / 3600.0).max(0.05 / 3600.0);
                branches.push(Branch {
                    a,
                    b,
                    // constant head h0 with resistance sized so the drop equals
                    // h0 exactly at qMax: a real falling pump characteristic that
                    // bounds flow to [0, qMax] and stays numerically stable.
                    k: h0 / (qmax * qmax),
                    pump_h0: h0,
                    pump_qmax: qmax,
                    q: qmax * 0.5,
                    edge_id: None,
                });
            }
            Role::Group => {
                // 4-port pump group: pump drives pri_in -> sec_out (supply
                // through the group); the return runs sec_in -> pri_out.
                // Mirrors tsSolver `case 'group'` in build (same constant-head
                // pump model as Role::Pump, default h0 50 kPa).
                let pin = nb.ensure(ni, &node.id, "pri_in");
                let pout = nb.ensure(ni, &node.id, "pri_out");
                let sout = nb.ensure(ni, &node.id, "sec_out");
                let sin = nb.ensure(ni, &node.id, "sec_in");
                let h0 = node.p("h0Kpa", 50.0) * 1000.0;
                let qmax = (node.p("qMaxM3h", 3.0) / 3600.0).max(0.05 / 3600.0);
                branches.push(Branch {
                    a: pin,
                    b: sout,
                    k: h0 / (qmax * qmax),
                    pump_h0: h0,
                    pump_qmax: qmax,
                    q: qmax * 0.5,
                    edge_id: None,
                });
                branches.push(Branch {
                    a: sin,
                    b: pout,
                    k: k_floor(minor_k(0.6)),
                    pump_h0: 0.0,
                    pump_qmax: 0.0,
                    q: 0.0001,
                    edge_id: None,
                });
            }
            Role::Source => {
                let a = nb.ensure(ni, &node.id, "ret");
                let b = nb.ensure(ni, &node.id, "sup");
                if node.has("h0Kpa") {
                    // built-in circulator: the source drives its own loop (ret -> sup)
                    let h0 = node.p("h0Kpa", 45.0) * 1000.0;
                    let qmax = (node.p("qMaxM3h", 2.0) / 3600.0).max(0.05 / 3600.0);
                    branches.push(Branch {
                        a,
                        b,
                        k: h0 / (qmax * qmax),
                        pump_h0: h0,
                        pump_qmax: qmax,
                        q: qmax * 0.5,
                        edge_id: None,
                    });
                } else {
                    // no built-in pump (e.g. solar) — needs an external circulator
                    branches.push(Branch {
                        a,
                        b,
                        k: pipe_k(2.0, 26.0, rho),
                        pump_h0: 0.0,
                        pump_qmax: 0.0,
                        q: 0.0001,
                        edge_id: None,
                    });
                }
            }
            Role::Emitter => {
                let a = nb.ensure(ni, &node.id, "sup");
                let b = nb.ensure(ni, &node.id, "ret");
                branches.push(Branch {
                    a,
                    b,
                    k: pipe_k(10.0, 14.0, rho),
                    pump_h0: 0.0,
                    pump_qmax: 0.0,
                    q: 0.0001,
                    edge_id: None,
                });
            }
            Role::Valve => {
                let hot = nb.ensure(ni, &node.id, "hot");
                let cold = nb.ensure(ni, &node.id, "cold");
                let mix = nb.ensure(ni, &node.id, "mix");
                branches.push(Branch {
                    a: hot,
                    b: mix,
                    k: k_floor(minor_k(2.0)),
                    pump_h0: 0.0,
                    pump_qmax: 0.0,
                    q: 0.0001,
                    edge_id: None,
                });
                branches.push(Branch {
                    a: cold,
                    b: mix,
                    k: k_floor(minor_k(2.0)),
                    pump_h0: 0.0,
                    pump_qmax: 0.0,
                    q: 0.0001,
                    edge_id: None,
                });
            }
            Role::Tank | Role::Junction => {
                // STAR: connect every CONNECTED port (from edges) to the first
                // with small resistance — generic over configurable tappings,
                // tee/cross fittings, etc.
                let ports = node_port_ids.get(&node.id).unwrap_or(&empty_ports);
                if ports.len() >= 2 {
                    let center = nb.ensure(ni, &node.id, &ports[0]);
                    let kk = k_floor(minor_k(node.p("kKpa", 0.4)));
                    for pid in &ports[1..] {
                        let pi = nb.ensure(ni, &node.id, pid);
                        branches.push(Branch {
                            a: center,
                            b: pi,
                            k: kk,
                            pump_h0: 0.0,
                            pump_qmax: 0.0,
                            q: 0.0001,
                            edge_id: None,
                        });
                    }
                }
            }
            Role::Manifold => {
                // TWO separate stars — a supply rail and a return rail — so the
                // hot supply can't short-circuit to the return inside the body;
                // flow must travel out through the circuits and back. Ports split
                // by pipe line (default supply). Mirrors tsSolver `case 'manifold'`.
                let ports = node_port_ids.get(&node.id).unwrap_or(&empty_ports);
                let kk = k_floor(minor_k(node.p("kKpa", 0.3)));
                for side in [PortLine::Supply, PortLine::Return] {
                    let group: Vec<&String> = ports
                        .iter()
                        .filter(|pid| {
                            let ln = port_line
                                .get(&format!("{}:{}", node.id, pid))
                                .copied()
                                .unwrap_or(PortLine::Supply);
                            ln == side
                        })
                        .collect();
                    if group.len() < 2 {
                        continue;
                    }
                    let center = nb.ensure(ni, &node.id, group[0]);
                    for pid in &group[1..] {
                        let pi = nb.ensure(ni, &node.id, pid);
                        branches.push(Branch {
                            a: center,
                            b: pi,
                            k: kk,
                            pump_h0: 0.0,
                            pump_qmax: 0.0,
                            q: 0.0001,
                            edge_id: None,
                        });
                    }
                }
            }
            Role::Passive => {
                // inline 2-port body (first two connected ports) or a single-port
                // dead-leg tap — using whatever ports the edges connect.
                let ports = node_port_ids.get(&node.id).unwrap_or(&empty_ports);
                if ports.len() >= 2 {
                    let a = nb.ensure(ni, &node.id, &ports[0]);
                    let b = nb.ensure(ni, &node.id, &ports[1]);
                    branches.push(Branch {
                        a,
                        b,
                        k: k_floor(minor_k(node.p("kKpa", 0.4))),
                        pump_h0: 0.0,
                        pump_qmax: 0.0,
                        q: 0.0001,
                        edge_id: None,
                    });
                } else if ports.len() == 1 {
                    nb.ensure(ni, &node.id, &ports[0]);
                }
            }
        }
    }

    // ---- external pipe branches ----
    for er in &req.edges {
        let from = *index
            .get(&er.from)
            .ok_or_else(|| format!("edge {} references unknown node {}", er.id, er.from))?;
        let to = *index
            .get(&er.to)
            .ok_or_else(|| format!("edge {} references unknown node {}", er.id, er.to))?;
        // A pipe endpoint may name a port the role already created (then `ensure`
        // returns the same index) or a fresh one (e.g. a passive's `tap`).
        let a = nb.ensure(from, &er.from, &er.from_port);
        let b = nb.ensure(to, &er.to, &er.to_port);
        branches.push(Branch {
            a,
            b,
            k: pipe_k(er.length_m, er.diameter_mm, rho),
            pump_h0: 0.0,
            pump_qmax: 0.0,
            q: 0.0001,
            edge_id: Some(er.id.clone()),
        });
    }

    Ok(Network {
        nodes,
        branches,
        port_owner: nb.port_owner,
        node_ports: nb.node_ports,
        port_index: nb.port_index,
        port_line,
        fluid,
        ambient_c: req.ambient_c,
    })
}

/// Pump head [Pa] supplied along a branch's a→b direction. Constant `h0`; the
/// branch's own resistance (`k = h0/qmax²`) provides the falling characteristic
/// and bounds flow to [0, qmax]. Mirrors tsSolver's constant-head pump model.
fn branch_head(br: &Branch, _q: f64) -> f64 {
    if br.pump_h0 <= 0.0 {
        return 0.0;
    }
    br.pump_h0
}

struct HydraulicSolution {
    iterations: u32,
    residual: f64,
    has_flow: bool,
    max_pump_head_kpa: f64,
}

/// Linear-theory nodal iteration over the PORT nodes. Each branch is linearised
/// as R = k·|q| (+ constant pump head H); the nodal (graph-Laplacian) system
/// A·p = rhs then enforces continuity at every non-reference port. Reference
/// one port per connected component is pinned at p = 0 (port 0 for the main
/// loop, plus any disconnected dead leg / isolated tap); no leak term, so mass
/// is conserved exactly at every non-pinned port. Flows are updated with 0.7
/// relaxation while iterating R. After convergence a
/// SINGLE final un-relaxed flow pass is taken from the converged pressures: the
/// relaxed iterate lags and leaves a few-percent mass imbalance (which piles up
/// on the slack node), whereas q = (pa−pb+H)/R derived directly from the
/// Laplacian solution conserves mass exactly at every non-slack port. Mirrors
/// tsSolver's hydraulic loop.
fn solve_hydraulics(net: &mut Network) -> HydraulicSolution {
    let n = net.port_owner.len();
    let has_pump = net.branches.iter().any(|b| b.pump_h0 > 0.0);

    if n == 0 || net.branches.is_empty() || !has_pump {
        return HydraulicSolution {
            iterations: 0,
            residual: 0.0,
            has_flow: false,
            max_pump_head_kpa: 0.0,
        };
    }

    // The nodal Laplacian is singular on every connected component (zero row-sum),
    // so each component needs exactly one pinned port to be solvable. Pin the
    // lowest-index port of EACH component — this keeps port 0 pinned as before, and
    // also grounds any disconnected dead leg / isolated tap without a leak term.
    // With no leak anywhere, A·p = rhs is exact continuity at every non-pinned port,
    // so mass is conserved exactly in every component (the old blanket 1e-12 leak
    // stole ~leak·p_i from each live node and broke the balance).
    let mut pinned = vec![false; n];
    {
        let mut adj: Vec<Vec<usize>> = vec![Vec::new(); n];
        for br in net.branches.iter() {
            adj[br.a].push(br.b);
            adj[br.b].push(br.a);
        }
        let mut seen = vec![false; n];
        for s in 0..n {
            if seen[s] {
                continue;
            }
            let mut min_idx = s;
            let mut stack = vec![s];
            seen[s] = true;
            while let Some(i) = stack.pop() {
                if i < min_idx {
                    min_idx = i;
                }
                for &j in &adj[i] {
                    if !seen[j] {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
            pinned[min_idx] = true;
        }
    }
    let mut iterations = 0u32;
    let mut residual = f64::INFINITY;
    // hoisted so the converged pressures stay in scope for the final
    // continuity-exact pass after the loop (mirrors tsSolver `let p = ...`)
    let mut p = vec![0.0f64; n];
    // conductance captured at A-build time each iteration; the final pass must use
    // THESE (the values that actually built the solved matrix), not a recompute from
    // the post-update br.q — otherwise q_final no longer satisfies continuity.
    let mut cond_final = vec![0.0f64; net.branches.len()];

    for it in 0..400u32 {
        iterations = it + 1;

        let mut g = vec![vec![0.0f64; n]; n];
        let mut b = vec![0.0f64; n];

        for (bi, br) in net.branches.iter().enumerate() {
            let absq = br.q.abs().max(Q_FLOOR);
            let r = br.k * absq;
            let cond = 1.0 / r;
            let h = branch_head(br, br.q);
            let (i, j) = (br.a, br.b);
            g[i][i] += cond;
            g[i][j] -= cond;
            g[j][j] += cond;
            g[j][i] -= cond;
            // pump source term: +H/R leaving a, entering b
            b[i] -= h / r;
            b[j] += h / r;
            cond_final[bi] = cond;
        }

        // pin one port per connected component (no leak — see note above); this also
        // pins the reference port 0, which is its component's lowest index
        for i in 0..n {
            if pinned[i] {
                for c in 0..n {
                    g[i][c] = 0.0;
                }
                g[i][i] = 1.0;
                b[i] = 0.0;
            }
        }

        let mut a = g;
        let mut rhs = b;
        if !gauss_solve(&mut a, &mut rhs, n) {
            return HydraulicSolution {
                iterations,
                residual,
                has_flow: false,
                max_pump_head_kpa: 0.0,
            };
        }
        p = rhs;

        let mut max_dq = 0.0f64;
        for br in net.branches.iter_mut() {
            let absq = br.q.abs().max(Q_FLOOR);
            let r = br.k * absq;
            let h = branch_head(br, br.q);
            let q_new = (p[br.a] - p[br.b] + h) / r;
            let dq = (q_new - br.q).abs();
            if dq > max_dq {
                max_dq = dq;
            }
            br.q += 0.7 * (q_new - br.q); // under-relax for stability
        }
        residual = max_dq;
        if max_dq < 1e-9 {
            break;
        }
    }

    // final continuity-exact flows from the converged pressures, using the SAME
    // conductances that built the solved matrix (cond_final). Recomputing R from the
    // post-update br.q would desync q from A·p=rhs and break mass balance at every
    // non-slack port. Mirrors tsSolver's post-loop pass.
    for (bi, br) in net.branches.iter_mut().enumerate() {
        let h = branch_head(br, br.q);
        br.q = cond_final[bi] * (p[br.a] - p[br.b] + h);
    }

    let max_head_kpa = net
        .branches
        .iter()
        .filter(|b| b.pump_h0 > 0.0)
        .map(|b| {
            // delivered head = h0·(1 − (Q/qmax)²), clamped ≥ 0 (for reporting)
            let ratio = (b.q.abs() / b.pump_qmax).min(1.0);
            (b.pump_h0 * (1.0 - ratio * ratio)).max(0.0) / 1000.0
        })
        .fold(0.0f64, f64::max);

    // flow significance is judged on external pipe flow (what the app shows)
    let any_flow = net
        .branches
        .iter()
        .any(|b| b.edge_id.is_some() && b.q.abs() > 1e-7);

    HydraulicSolution {
        iterations,
        residual,
        has_flow: any_flow,
        max_pump_head_kpa: max_head_kpa,
    }
}

// ---------------------------------------------------------------------------
// Thermal solve (port-level component sweep)
// ---------------------------------------------------------------------------

/// One end of an external pipe as seen from a given port.
struct Link {
    other: usize,    // the port at the other end of the pipe
    q: f64,          // |flow| through the pipe [m³/s]
    from_here: bool, // true if fluid leaves THIS port (into the pipe)
}

/// Per-node thermal info captured during the sweep (mirrors the bundled
/// tsSolver `info` map of `{ tIn, tOut, mdot }`). Both the per-node result and
/// the global metrics are derived from these — using the REAL hydraulic mass
/// flow `mdot`, not a heat/ΔT back-estimate.
#[derive(Clone, Copy)]
struct Info {
    t_in: f64,
    t_out: f64,
    mdot: f64, // kg/s through the node (inflow mass)
}

/// Pump-group state captured during the sweep: distinct primary/secondary in/out
/// temps. Mirrors tsSolver's `groupInfo` map. The group does NOT mix all ports —
/// it keeps the primary (pri_in/pri_out) and secondary (sec_in/sec_out) sides
/// separate, so the standard single-mix `Info` cannot represent it.
#[derive(Clone, Copy)]
struct GroupInfo {
    t_pri_in: f64,
    t_sec_in: f64,
    t_sec_out: f64,
    // Written to the pri_out port temp during the sweep; retained here to mirror
    // tsSolver's `groupInfo` (not read back for the node result, hence allow).
    #[allow(dead_code)]
    t_pri_out: f64,
    mdot: f64, // kg/s (max of pri/sec inflow mass) * rho
}

/// Stratified-buffer state captured during the sweep: top (hot/supply side) and
/// bottom (cool/return side) zone temps. Mirrors tsSolver's `tankInfo` map. A
/// buffer tank (role `tank`, NO `setpointC`) is NOT a well-mixed junction — it
/// keeps two distinct zones, so the single-mix `Info` cannot represent it.
#[derive(Clone, Copy)]
struct TankInfo {
    top: f64,
    bot: f64,
    // Bulk throughput retained to mirror tsSolver's `tankInfo` (not read back for
    // the node result, which derives from top/bot only).
    #[allow(dead_code)]
    mdot: f64,
}

/// Manifold state captured during the sweep: supply-rail temp + return-rail temp,
/// kept strictly separate. Mirrors tsSolver's `manInfo` map. A manifold has a
/// SUPPLY rail and a RETURN rail that must NOT mix (unlike a junction, which is a
/// single well-mixed star), so the single-mix `Info` cannot represent it.
#[derive(Clone, Copy)]
struct ManInfo {
    sup: f64,
    ret: f64,
}

/// Per-node reportable result.
#[derive(Clone, Default)]
struct NodeOut {
    heat_kw: Option<f64>,
    supply_c: Option<f64>,
    return_c: Option<f64>,
    valve_pct: Option<f64>,
    cop: Option<f64>,
    strat: Option<Vec<f64>>,
}

struct ThermalSolution {
    iterations: u32,
    residual: f64,
    history: Vec<HistoryEntry>,
    global_flow_m3h: f64,
    global_supply_c: f64,
    global_return_c: f64,
    global_heat_kw: f64,
    global_cop: Option<f64>,
    node_out: Vec<NodeOut>,
    /// final per-port temperatures (for edge temp reporting)
    port_temp: Vec<f64>,
}

/// Emitter outlet temperature solved from the heat-emission balance by bisection:
/// `ṁ·cp·(Tin − Tout) = UA·(((Tin+Tout)/2) − room)^n`, Tout ∈ [room, Tin].
/// Mirrors tsSolver's 40-iteration bisection exactly.
fn emitter_outlet(t_in: f64, m_cp: f64, ua: f64, room_c: f64, n_exp: f64) -> f64 {
    let mut lo = room_c;
    let mut hi = t_in;
    for _ in 0..40 {
        let mid = 0.5 * (lo + hi);
        let tmean = 0.5 * (t_in + mid);
        let q_emit = ua * (tmean - room_c).max(0.0).powf(n_exp);
        let q_fluid = m_cp * (t_in - mid);
        if q_fluid > q_emit {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

/// Apply a node's thermal role: given the mixed inlet temp and throughput,
/// return the outlet temp written to every outflow port. Mirrors tsSolver
/// `applyComponent` (with the source/emitter/valve/tank/junction rules).
fn apply_component(node: &Node, t_in: f64, mdot: f64, cp: f64, ambient: f64) -> f64 {
    let eps = 1e-6;
    match node.role {
        Role::Source => {
            let max_supply = node.p("maxSupplyC", 75.0);
            if mdot < eps {
                return max_supply.min(t_in);
            }
            let rise = node.p("ratedKw", 24.0) * 1000.0 / (mdot * cp);
            max_supply.min(t_in + rise)
        }
        Role::Emitter => {
            let room = node.p("roomC", 20.0);
            let n_exp = node.p("exponent", 1.3);
            let excess = node.p("ratedExcessC", 50.0).max(1.0);
            let ua = node.p("ratedKw", 2.0) * 1000.0 / excess.powf(n_exp);
            if mdot < eps {
                return t_in;
            }
            emitter_outlet(t_in, mdot * cp, ua, room, n_exp)
        }
        Role::Valve => {
            // blend toward target clamped to [coldIn, hotIn]; here tIn is the mix
            let target = node.p("targetC", 40.0);
            let t = if target > t_in { t_in } else { target };
            ambient.max(t_in.min(t))
        }
        Role::Tank => {
            if node.has("setpointC") {
                // DHW cylinder draws a standby load
                let draw = node.p("standbyKw", 0.0) * 1000.0;
                if mdot < eps {
                    return t_in;
                }
                t_in - draw / (mdot * cp)
            } else {
                // buffer tank: NEVER reaches here — a non-DHW tank is special-
                // cased (and `continue`d) by the 2-zone stratified block in the
                // thermal sweep before apply_component. Listed for completeness.
                t_in
            }
        }
        // Group and Manifold never reach here — both are special-cased (and
        // `continue`d) in the thermal sweep before apply_component. Listed for
        // match exhaustiveness.
        Role::Junction | Role::Pump | Role::Passive | Role::Group | Role::Manifold => t_in,
    }
}

/// Mixed inflow temperature + mass arriving at ONE specific port (by port index).
/// Mirrors tsSolver's `portInflow`: averages only the pipe links whose solved
/// flow ENTERS this port. Returns `(temp, mass)` with `temp = NaN` when no inflow
/// (caller then keeps the previous value or ambient), `mass` in m³/s.
fn port_inflow(port_idx: usize, pipe_links: &[Vec<Link>], port_temp: &[f64]) -> (f64, f64) {
    let mut m = 0.0f64;
    let mut e = 0.0f64;
    for lk in pipe_links[port_idx].iter() {
        if !lk.from_here && lk.q > Q_FLOOR {
            m += lk.q;
            e += lk.q * port_temp[lk.other];
        }
    }
    if m > Q_FLOOR {
        (e / m, m)
    } else {
        (f64::NAN, m)
    }
}

fn solve_thermal(net: &Network) -> ThermalSolution {
    let cp = net.fluid.cp_jkg_k;
    let rho = net.fluid.rho_kg_m3;
    let n_nodes = net.nodes.len();
    let n_ports = net.port_owner.len();
    let ambient = net.ambient_c;

    // ---- pipe links per port (external branches only) ----
    let mut pipe_links: Vec<Vec<Link>> = (0..n_ports).map(|_| Vec::new()).collect();
    for br in net.branches.iter() {
        if br.edge_id.is_none() {
            continue;
        }
        let mq = br.q.abs();
        let a_leaves = br.q > 0.0; // a->b
        pipe_links[br.a].push(Link {
            other: br.b,
            q: mq,
            from_here: a_leaves,
        });
        pipe_links[br.b].push(Link {
            other: br.a,
            q: mq,
            from_here: !a_leaves,
        });
    }

    // port temperatures, init ambient
    let mut port_temp = vec![ambient; n_ports];

    // per-port pipe line (supply/return), defaulting to supply — mirrors
    // tsSolver's `portLine.get(...) ?? 'supply'`. Used by the stratified-buffer
    // block to split inflows into the hot top vs the cool bottom zone. Built
    // once by reversing port_index so the sweep needs no string formatting.
    let mut port_side: Vec<PortLine> = vec![PortLine::Supply; n_ports];
    for (key, &idx) in net.port_index.iter() {
        if let Some(&ln) = net.port_line.get(key) {
            port_side[idx] = ln;
        }
    }

    // per-node info {tIn, tOut, mdot}; tOut seeded to ambient
    let mut info: Vec<Info> = vec![
        Info {
            t_in: ambient,
            t_out: ambient,
            mdot: 0.0,
        };
        n_nodes
    ];
    // pump-group state: distinct primary/secondary in/out temps (mirrors
    // tsSolver `groupInfo`). None until the node is first visited.
    let mut group_info: Vec<Option<GroupInfo>> = vec![None; n_nodes];
    // stratified-buffer state: top/bottom zone temps (mirrors tsSolver
    // `tankInfo`). None until the node is first visited.
    let mut tank_info: Vec<Option<TankInfo>> = vec![None; n_nodes];
    // manifold state: supply-rail temp + return-rail temp (mirrors tsSolver
    // `manInfo`). None until the node is first visited.
    let mut man_info: Vec<Option<ManInfo>> = vec![None; n_nodes];

    let mut history: Vec<HistoryEntry> = Vec::new();
    let mut iterations = 0u32;
    let mut residual = f64::INFINITY;

    for it in 0..120u32 {
        iterations = it + 1;
        let mut max_dt = 0.0f64;

        for ni in 0..n_nodes {
            let node = &net.nodes[ni];

            if node.role == Role::Group {
                // 4-port pump group: hot enters pri_in, the load is served from
                // sec_out; the load return enters sec_in and the cooled primary
                // leaves pri_out. The group does NOT mix all ports — primary and
                // secondary temps stay distinct. Mirrors tsSolver `if (n.role
                // === 'group')` in the thermal sweep.
                let pin_idx = net.port_index.get(&format!("{}:pri_in", node.id)).copied();
                let sin_idx = net.port_index.get(&format!("{}:sec_in", node.id)).copied();
                let prev = group_info[ni];
                // mixed inflow at pri_in / sec_in SEPARATELY (over only that
                // port's inflowing pipes); if none, keep previous or ambient.
                let (pi_temp, pi_mass) = pin_idx
                    .map(|i| port_inflow(i, &pipe_links, &port_temp))
                    .unwrap_or((f64::NAN, 0.0));
                let (si_temp, si_mass) = sin_idx
                    .map(|i| port_inflow(i, &pipe_links, &port_temp))
                    .unwrap_or((f64::NAN, 0.0));
                let t_pri_in = if pi_temp.is_finite() {
                    pi_temp
                } else {
                    prev.map(|g| g.t_pri_in).unwrap_or(ambient)
                };
                let t_sec_in = if si_temp.is_finite() {
                    si_temp
                } else {
                    prev.map(|g| g.t_sec_in).unwrap_or(ambient)
                };
                let mdot = pi_mass.max(si_mass) * rho;
                let (t_sec_out, t_pri_out) = if node.has("targetSupplyC") {
                    // mixing: blend down to the target, energy from the primary
                    let target = node.p("targetSupplyC", 0.0);
                    let so = t_sec_in.max(t_pri_in.min(target));
                    (so, t_pri_in - (so - t_sec_in))
                } else {
                    // direct: pass the hot through; load return -> primary return
                    (t_pri_in, t_sec_in)
                };
                let prev_so = prev.map(|g| g.t_sec_out).unwrap_or(ambient);
                let dt = (t_sec_out - prev_so).abs();
                if dt > max_dt {
                    max_dt = dt;
                }
                // write the two DISTINCT outlet port temps (inlet ports pri_in/
                // sec_in are not used as upstreams, so they need no write).
                if let Some(i) = net.port_index.get(&format!("{}:sec_out", node.id)).copied() {
                    port_temp[i] = t_sec_out;
                }
                if let Some(i) = net.port_index.get(&format!("{}:pri_out", node.id)).copied() {
                    port_temp[i] = t_pri_out;
                }
                group_info[ni] = Some(GroupInfo {
                    t_pri_in,
                    t_sec_in,
                    t_sec_out,
                    t_pri_out,
                    mdot,
                });
                continue;
            }

            if node.role == Role::Tank && !node.has("setpointC") {
                // energy-balanced 2-zone stratified buffer: hot charge enters the
                // top (supply-side inflow), cool load return enters the bottom
                // (return-side inflow); loads draw the top, the source draws the
                // bottom. When charge flow exceeds load flow the surplus hot
                // overflows downward (and vice versa), which conserves energy
                // exactly. Mirrors tsSolver's `if (n.role === 'tank' && ...)`
                // block in the thermal sweep.
                let mut charge_m = 0.0f64; // hot charge mass (supply-side inflow)
                let mut charge_e = 0.0f64;
                let mut ret_in_m = 0.0f64; // cool return mass (return-side inflow)
                let mut ret_in_e = 0.0f64;
                for &idx in net.node_ports[ni].iter() {
                    let side = port_side[idx];
                    for lk in pipe_links[idx].iter() {
                        if lk.from_here || lk.q <= Q_FLOOR {
                            continue; // inflows only
                        }
                        if side == PortLine::Supply {
                            charge_m += lk.q;
                            charge_e += lk.q * port_temp[lk.other];
                        } else {
                            ret_in_m += lk.q;
                            ret_in_e += lk.q * port_temp[lk.other];
                        }
                    }
                }
                let prev = tank_info[ni];
                let charge_t = if charge_m > Q_FLOOR {
                    charge_e / charge_m
                } else {
                    prev.map(|t| t.top).unwrap_or(ambient)
                };
                let ret_t = if ret_in_m > Q_FLOOR {
                    ret_in_e / ret_in_m
                } else {
                    prev.map(|t| t.bot).unwrap_or(ambient)
                };
                let fs = charge_m.max(1e-9);
                let fl = ret_in_m.max(1e-9);
                let (top, bot) = if fs >= fl {
                    // surplus hot overflows down
                    let top = charge_t;
                    (top, (fl * ret_t + (fs - fl) * top) / fs)
                } else {
                    // surplus draw pulls cold up
                    let bot = ret_t;
                    ((fs * charge_t + (fl - fs) * bot) / fl, bot)
                };
                // write every supply-side port to top, every return-side to bot
                for &idx in net.node_ports[ni].iter() {
                    port_temp[idx] = if port_side[idx] == PortLine::Supply {
                        top
                    } else {
                        bot
                    };
                }
                // track BOTH zones for convergence — the bottom (return) zone can
                // still be climbing while the top is steady; tracking only the top
                // lets the sweep declare convergence prematurely. Mirrors tsSolver
                // `Math.max(maxDt, |top-prevTop|, |bot-prevBot|)`.
                let prev_top = prev.map(|t| t.top).unwrap_or(ambient);
                let prev_bot = prev.map(|t| t.bot).unwrap_or(ambient);
                let d_top = (top - prev_top).abs();
                let d_bot = (bot - prev_bot).abs();
                if d_top > max_dt {
                    max_dt = d_top;
                }
                if d_bot > max_dt {
                    max_dt = d_bot;
                }
                tank_info[ni] = Some(TankInfo {
                    top,
                    bot,
                    mdot: (charge_m + ret_in_m) * rho,
                });
                continue;
            }

            if node.role == Role::Manifold {
                // supply rail carries the supply-side inflow temp, return rail the
                // return-side inflow mix — the two rails do NOT mix with each
                // other. Mirrors tsSolver's `if (n.role === 'manifold')` block.
                let mut sup_m = 0.0f64;
                let mut sup_e = 0.0f64;
                let mut ret_m = 0.0f64;
                let mut ret_e = 0.0f64;
                for &idx in net.node_ports[ni].iter() {
                    let side = port_side[idx];
                    for lk in pipe_links[idx].iter() {
                        if lk.from_here || lk.q <= Q_FLOOR {
                            continue; // inflows only
                        }
                        if side == PortLine::Supply {
                            sup_m += lk.q;
                            sup_e += lk.q * port_temp[lk.other];
                        } else {
                            ret_m += lk.q;
                            ret_e += lk.q * port_temp[lk.other];
                        }
                    }
                }
                let prev = man_info[ni];
                let sup_t = if sup_m > Q_FLOOR {
                    sup_e / sup_m
                } else {
                    prev.map(|m| m.sup).unwrap_or(ambient)
                };
                let ret_t = if ret_m > Q_FLOOR {
                    ret_e / ret_m
                } else {
                    prev.map(|m| m.ret).unwrap_or(ambient)
                };
                // write every supply-side port to sup_t, every return-side to ret_t
                for &idx in net.node_ports[ni].iter() {
                    port_temp[idx] = if port_side[idx] == PortLine::Supply {
                        sup_t
                    } else {
                        ret_t
                    };
                }
                // track BOTH rails for convergence — the return rail can still be
                // climbing while the supply rail is steady; missing it lets the
                // sweep declare convergence prematurely and freeze the loop cold.
                let prev_sup = prev.map(|m| m.sup).unwrap_or(ambient);
                let prev_ret = prev.map(|m| m.ret).unwrap_or(ambient);
                let d_sup = (sup_t - prev_sup).abs();
                let d_ret = (ret_t - prev_ret).abs();
                if d_sup > max_dt {
                    max_dt = d_sup;
                }
                if d_ret > max_dt {
                    max_dt = d_ret;
                }
                man_info[ni] = Some(ManInfo {
                    sup: sup_t,
                    ret: ret_t,
                });
                continue;
            }

            // mixed inlet temp from INFLOW ports (a port is inflow if the
            // connected pipe's solved flow enters it). Reads port temps.
            let mut in_mass = 0.0f64;
            let mut in_energy = 0.0f64;
            for &idx in net.node_ports[ni].iter() {
                for lk in pipe_links[idx].iter() {
                    if !lk.from_here && lk.q > Q_FLOOR {
                        in_mass += lk.q;
                        in_energy += lk.q * port_temp[lk.other];
                    }
                }
            }
            let t_in = if in_mass > Q_FLOOR {
                in_energy / in_mass
            } else {
                info[ni].t_out
            };
            let mdot = in_mass * rho; // kg/s

            let mut t_out = apply_component(node, t_in, mdot, cp, ambient);
            // guard: emitter never below its room temp (the bisection already
            // keeps Tout in [room, tIn], so this only fires on non-finite input)
            if node.role == Role::Emitter {
                let room = node.p("roomC", 20.0);
                if t_out < room {
                    t_out = room;
                }
            }
            if !t_out.is_finite() {
                t_out = ambient;
            }

            let prev = info[ni].t_out;
            let dt = (t_out - prev).abs();
            if dt > max_dt {
                max_dt = dt;
            }
            info[ni] = Info { t_in, t_out, mdot };

            // write all of this node's ports to t_out
            for &idx in net.node_ports[ni].iter() {
                port_temp[idx] = t_out;
            }
        }

        let g = compute_global(net, &info, rho, cp);
        history.push(HistoryEntry {
            iter: iterations,
            supply_c: g.supply_c,
            return_c: g.return_c,
            heat_kw: g.heat_kw,
        });
        residual = max_dt;
        if max_dt < 1e-4 {
            break;
        }
    }

    // ---- per-node reported fields (mirrors bundled tsSolver buildNodeResult) ----
    let mut node_out: Vec<NodeOut> = vec![NodeOut::default(); n_nodes];
    for ni in 0..n_nodes {
        let node = &net.nodes[ni];
        let inf = info[ni];
        let (t_in, t_out, mdot) = (inf.t_in, inf.t_out, inf.mdot);
        let mut nr = NodeOut::default();
        match node.role {
            Role::Source => {
                nr.heat_kw = Some(round1(mdot * cp * (t_out - t_in) / 1000.0));
                nr.supply_c = Some(round1(t_out));
                nr.return_c = Some(round1(t_in));
                if node.has("copRated") {
                    let cop = (node.p("copRated", 4.2) - 0.06 * (t_out - 35.0)
                        + 0.07 * (node.p("sourceC", 7.0) - 7.0))
                        .clamp(1.5, 6.5);
                    nr.cop = Some(round2(cop));
                }
            }
            Role::Emitter => {
                nr.heat_kw = Some(round1(mdot * cp * (t_in - t_out) / 1000.0));
                nr.supply_c = Some(round1(t_in));
                nr.return_c = Some(round1(t_out));
            }
            Role::Tank => {
                if node.has("setpointC") {
                    // DHW cylinder: single-node standby-draw handling (unchanged).
                    nr.supply_c = Some(round1(t_out));
                    nr.return_c = Some(round1(t_in));
                    nr.heat_kw = Some(-round1(node.p("standbyKw", 0.0)));
                } else if let Some(ti) = tank_info[ni] {
                    // energy-balanced 2-zone buffer: supplyC = hot top,
                    // returnC = cool bottom, strat = 6-point linear gradient
                    // top->bottom. Mirrors tsSolver's stratified-tank branch.
                    let hot = ti.top;
                    let cold = ti.bot;
                    nr.supply_c = Some(round1(hot));
                    nr.return_c = Some(round1(cold));
                    let layers: Vec<f64> = (0..6)
                        .map(|i| round1(hot - (i as f64 / 5.0) * (hot - cold)))
                        .collect();
                    nr.strat = Some(layers);
                }
            }
            Role::Valve => {
                nr.supply_c = Some(round1(t_out));
                let range = (t_in - ambient).max(1.0);
                let pct = (((t_out - ambient) / range) * 100.0).clamp(0.0, 100.0);
                nr.valve_pct = Some(pct.round());
            }
            Role::Junction | Role::Pump => {
                // bundled tsSolver reports supplyC for pump/junction nodes
                nr.supply_c = Some(round1(t_out));
            }
            Role::Manifold => {
                // supply-rail + return-rail temps from the manifold sweep state;
                // no heatKw/strat. Mirrors tsSolver's manifold node-result branch.
                if let Some(mi) = man_info[ni] {
                    nr.supply_c = Some(round1(mi.sup));
                    nr.return_c = Some(round1(mi.ret));
                }
            }
            Role::Group => {
                // distinct primary/secondary temps from the group sweep state.
                // Mirrors tsSolver's group block in the node-result assembly.
                if let Some(gi) = group_info[ni] {
                    nr.heat_kw = Some(round1(gi.mdot * cp * (gi.t_sec_out - gi.t_sec_in) / 1000.0));
                    nr.supply_c = Some(round1(gi.t_sec_out));
                    nr.return_c = Some(round1(gi.t_sec_in));
                    if node.has("targetSupplyC") {
                        let span = (gi.t_pri_in - gi.t_sec_in).max(1.0);
                        let pct = (((gi.t_sec_out - gi.t_sec_in) / span) * 100.0).clamp(0.0, 100.0);
                        nr.valve_pct = Some(pct.round());
                    }
                }
            }
            Role::Passive => {}
        }
        node_out[ni] = nr;
    }

    let g = compute_global(net, &info, rho, cp);

    ThermalSolution {
        iterations,
        residual,
        history,
        global_flow_m3h: g.flow_m3h,
        global_supply_c: g.supply_c,
        global_return_c: g.return_c,
        global_heat_kw: g.heat_kw,
        global_cop: g.cop,
        node_out,
        port_temp,
    }
}

struct GlobalAgg {
    flow_m3h: f64,
    supply_c: f64,
    return_c: f64,
    heat_kw: f64,
    cop: Option<f64>,
}

/// Global metrics, mirroring the bundled tsSolver `computeGlobal`: over sources
/// with non-trivial mass flow, accumulate REAL hydraulic `mdot` and weight
/// supply/return by it; flow = Σmdot/ρ·3600; heat counts only positive delivered
/// (a source running in reverse contributes 0); COP weighted by mdot.
fn compute_global(net: &Network, info: &[Info], rho: f64, cp: f64) -> GlobalAgg {
    let mut sup_mass = 0.0f64;
    let mut sup_energy = 0.0f64;
    let mut ret_energy = 0.0f64;
    let mut heat = 0.0f64;
    let mut cop_sum = 0.0f64;
    let mut cop_mass = 0.0f64;

    for ni in 0..net.nodes.len() {
        if net.nodes[ni].role != Role::Source {
            continue;
        }
        let inf = info[ni];
        if inf.mdot < 1e-6 {
            continue;
        }
        let node = &net.nodes[ni];
        let delivered = inf.mdot * cp * (inf.t_out - inf.t_in) / 1000.0;
        sup_mass += inf.mdot;
        sup_energy += inf.mdot * inf.t_out;
        ret_energy += inf.mdot * inf.t_in;
        heat += delivered.max(0.0);
        if node.has("copRated") {
            let cop = (node.p("copRated", 4.2) - 0.06 * (inf.t_out - 35.0)
                + 0.07 * (node.p("sourceC", 7.0) - 7.0))
                .clamp(1.5, 6.5);
            cop_sum += cop * inf.mdot;
            cop_mass += inf.mdot;
        }
    }

    let flow = if sup_mass > 1e-6 {
        sup_mass / rho * 3600.0
    } else {
        0.0
    };
    GlobalAgg {
        flow_m3h: round2(flow),
        supply_c: if sup_mass > 1e-6 {
            round1(sup_energy / sup_mass)
        } else {
            0.0
        },
        return_c: if sup_mass > 1e-6 {
            round1(ret_energy / sup_mass)
        } else {
            0.0
        },
        heat_kw: round1(heat),
        cop: if cop_mass > 1e-6 {
            Some(round2(cop_sum / cop_mass))
        } else {
            None
        },
    }
}

/// Mid temperature of the port-temp range (for supply/return line classification).
fn mid_temp(port_temp: &[f64]) -> f64 {
    if port_temp.is_empty() {
        return 40.0;
    }
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for &t in port_temp {
        if t < lo {
            lo = t;
        }
        if t > hi {
            hi = t;
        }
    }
    0.5 * (lo + hi)
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

fn run_solve(req: &SolveRequest) -> SolveResult {
    let t_start = now_ms();

    if req.nodes.is_empty() {
        return SolveResult {
            status: "empty".to_string(),
            iterations: 0,
            residual: 0.0,
            elapsed_ms: now_ms() - t_start,
            message: Some("no nodes in request".to_string()),
            global: GlobalResult::default(),
            edges: HashMap::new(),
            nodes: HashMap::new(),
            history: Vec::new(),
        };
    }

    let mut net = match build_network(req) {
        Ok(net) => net,
        Err(e) => {
            return SolveResult {
                status: "error".to_string(),
                iterations: 0,
                residual: 0.0,
                elapsed_ms: now_ms() - t_start,
                message: Some(e),
                global: GlobalResult::default(),
                edges: HashMap::new(),
                nodes: HashMap::new(),
                history: Vec::new(),
            };
        }
    };

    let hyd = solve_hydraulics(&mut net);

    if !hyd.has_flow {
        // echo zeroed entries (no pump / no loop / singular)
        let mut edges_out = HashMap::new();
        for br in net.branches.iter() {
            if let Some(id) = &br.edge_id {
                edges_out.insert(
                    id.clone(),
                    EdgeResult {
                        flow_m3h: 0.0,
                        temp_c: req.ambient_c,
                        line: "supply".to_string(),
                        dir: 0.0,
                    },
                );
            }
        }
        let mut nodes_out = HashMap::new();
        for nd in net.nodes.iter() {
            nodes_out.insert(nd.id.clone(), NodeResult::default());
        }
        return SolveResult {
            status: "empty".to_string(),
            iterations: hyd.iterations,
            residual: hyd.residual,
            elapsed_ms: now_ms() - t_start,
            message: Some("no pump head or no closed loop; zero flow".to_string()),
            // a sealed system still holds its cold static pressure with no flow
            global: GlobalResult {
                pressure_kpa: static_pressure_kpa(req, req.ambient_c),
                ..GlobalResult::default()
            },
            edges: edges_out,
            nodes: nodes_out,
            history: Vec::new(),
        };
    }

    let thermal = solve_thermal(&net);
    let mid = mid_temp(&thermal.port_temp);

    // ---- edge results: temp = upstream port temp ----
    let mut edges_out = HashMap::new();
    for br in net.branches.iter() {
        let id = match &br.edge_id {
            Some(id) => id,
            None => continue,
        };
        let upstream = if br.q >= 0.0 { br.a } else { br.b };
        let temp_c = thermal.port_temp[upstream];
        // A shut device (SHUT_K) still leaks a sub-Q_FLOOR trickle through its huge
        // resistance; report it as exactly zero so the readout shows "0.00" and no
        // animation, not 1e-4 m³/h.
        let flow_m3h = if br.q.abs() < Q_FLOOR {
            0.0
        } else {
            br.q.abs() * 3600.0
        };
        let line = if temp_c >= mid { "supply" } else { "return" };
        edges_out.insert(
            id.clone(),
            EdgeResult {
                flow_m3h,
                temp_c,
                line: line.to_string(),
                dir: if br.q.abs() < Q_FLOOR {
                    0.0
                } else if br.q >= 0.0 {
                    1.0
                } else {
                    -1.0
                },
            },
        );
    }

    // ---- node results (bundled tsSolver writes buildNodeResult for every node) ----
    let mut nodes_out = HashMap::new();
    for (ni, nd) in net.nodes.iter().enumerate() {
        let no = &thermal.node_out[ni];
        nodes_out.insert(
            nd.id.clone(),
            NodeResult {
                heat_kw: no.heat_kw,
                supply_c: no.supply_c,
                return_c: no.return_c,
                valve_pct: no.valve_pct,
                cop: no.cop,
                strat: no.strat.clone(),
            },
        );
    }

    // ---- globals ----
    let flow_m3h = thermal.global_flow_m3h;
    let head_kpa = hyd.max_pump_head_kpa;
    let delta_c = (thermal.global_supply_c - thermal.global_return_c).max(0.0);
    let status = if flow_m3h > 1e-3 {
        "converged"
    } else {
        "empty"
    };

    let global = GlobalResult {
        flow_m3h,
        head_kpa,
        pressure_kpa: static_pressure_kpa(
            req,
            (thermal.global_supply_c + thermal.global_return_c) / 2.0,
        ),
        supply_c: thermal.global_supply_c,
        return_c: thermal.global_return_c,
        delta_c,
        heat_kw: thermal.global_heat_kw,
        cop: thermal.global_cop,
    };

    SolveResult {
        status: status.to_string(),
        iterations: hyd.iterations + thermal.iterations,
        residual: thermal.residual,
        elapsed_ms: now_ms() - t_start,
        message: None,
        global,
        edges: edges_out,
        nodes: nodes_out,
        history: thermal.history,
    }
}

// ---------------------------------------------------------------------------
// Rounding helpers (match tsSolver round1/round2)
// ---------------------------------------------------------------------------

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}
fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

// Sealed-system GAUGE pressure [kPa] = cold-fill setpoint + thermal-expansion
// rise (water expands as it heats, the expansion vessel buffers it; a bigger
// vessel softens the swing). STATIC quantity, independent of pump head. Mirrors
// tsSolver staticPressureKpa.
fn static_pressure_kpa(req: &SolveRequest, mean_temp_c: f64) -> f64 {
    let (fill_kpa, vessel_l) = match &req.pressure {
        Some(p) => (
            if p.fill_kpa > 0.0 { p.fill_kpa } else { 120.0 },
            if p.vessel_l > 0.0 { p.vessel_l } else { 12.0 },
        ),
        None => (120.0, 12.0),
    };
    let d_t = (mean_temp_c - 15.0).max(0.0);
    let vessel_factor = (12.0 / vessel_l.max(4.0)).clamp(0.5, 2.0);
    round1(fill_kpa + 0.9 * d_t * vessel_factor)
}

// ---------------------------------------------------------------------------
// Timing helper (works in wasm browser and native tests)
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn now_ms() -> f64 {
    0.0
}

#[cfg(not(target_arch = "wasm32"))]
fn now_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

// ---------------------------------------------------------------------------
// Public wasm entry point
// ---------------------------------------------------------------------------

/// Parse a `SolveRequest` JSON string, run the steady-state solve, and return a
/// `SolveResult` JSON string. Never panics: parse/solve failures are reported as
/// a `status: "error"` result.
#[wasm_bindgen]
pub fn solve(request_json: &str) -> String {
    let req: SolveRequest = match serde_json::from_str(request_json) {
        Ok(r) => r,
        Err(e) => {
            let res = SolveResult {
                status: "error".to_string(),
                iterations: 0,
                residual: 0.0,
                elapsed_ms: 0.0,
                message: Some(format!("failed to parse request JSON: {}", e)),
                global: GlobalResult::default(),
                edges: HashMap::new(),
                nodes: HashMap::new(),
                history: Vec::new(),
            };
            return serde_json::to_string(&res)
                .unwrap_or_else(|_| "{\"status\":\"error\"}".to_string());
        }
    };

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_solve(&req)));
    let res = match result {
        Ok(r) => r,
        Err(_) => SolveResult {
            status: "error".to_string(),
            iterations: 0,
            residual: 0.0,
            elapsed_ms: 0.0,
            message: Some("internal solver panic".to_string()),
            global: GlobalResult::default(),
            edges: HashMap::new(),
            nodes: HashMap::new(),
            history: Vec::new(),
        },
    };

    serde_json::to_string(&res).unwrap_or_else(|_| "{\"status\":\"error\"}".to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, role: &str, params: &[(&str, f64)]) -> serde_json::Value {
        use serde_json::json;
        let mut m = serde_json::Map::new();
        for (k, v) in params {
            m.insert(k.to_string(), json!(v));
        }
        json!({ "id": id, "role": role, "params": m })
    }

    fn edge(
        id: &str,
        from: &str,
        from_port: &str,
        to: &str,
        to_port: &str,
        l: f64,
        d: f64,
    ) -> serde_json::Value {
        use serde_json::json;
        json!({
            "id": id,
            "from": from,
            "fromPort": from_port,
            "to": to,
            "toPort": to_port,
            "line": "auto",
            "lengthM": l,
            "diameterMm": d,
        })
    }

    // Like `edge` but with an explicit pipe `line` ('supply' | 'return') so a
    // buffer tank's ports get a definite hot-top / cool-bottom assignment.
    fn edge_line(
        id: &str,
        from: &str,
        from_port: &str,
        to: &str,
        to_port: &str,
        l: f64,
        d: f64,
        line: &str,
    ) -> serde_json::Value {
        use serde_json::json;
        json!({
            "id": id,
            "from": from,
            "fromPort": from_port,
            "to": to,
            "toPort": to_port,
            "line": line,
            "lengthM": l,
            "diameterMm": d,
        })
    }

    fn req_json(
        nodes: Vec<serde_json::Value>,
        edges: Vec<serde_json::Value>,
        ambient: f64,
    ) -> String {
        use serde_json::json;
        json!({
            "nodes": nodes,
            "edges": edges,
            "fluid": { "cpJkgK": 4186.0, "rhoKgM3": 997.0 },
            "ambientC": ambient,
            "mode": "steady",
        })
        .to_string()
    }

    fn parse(res_json: &str) -> serde_json::Value {
        serde_json::from_str(res_json).unwrap()
    }

    /// Assert mass conservation from the reported edge results: a flow along an
    /// edge (source->target, signed `dir*flowM3h`) LEAVES its `from` node (−) and
    /// ENTERS its `to` node (+). After the continuity-exact final hydraulic pass,
    /// the signed sum must vanish at every node except the single reference node
    /// (the first port created = node `ref_id`'s `ret`/first port, which carries
    /// the residual slack). `edge_topo` is (edgeId, fromNode, toNode); `ref_id` is
    /// excluded. Returns the worst non-reference |net| (m³/h) for logging.
    fn assert_node_continuity(
        v: &serde_json::Value,
        edge_topo: &[(&str, &str, &str)],
        ref_id: &str,
        tol: f64,
    ) -> f64 {
        let edges = v["edges"].as_object().unwrap();
        let mut net: HashMap<String, f64> = HashMap::new();
        for (_, from, to) in edge_topo {
            net.entry((*from).to_string()).or_insert(0.0);
            net.entry((*to).to_string()).or_insert(0.0);
        }
        for (eid, from, to) in edge_topo {
            let er = &edges[*eid];
            let signed = er["dir"].as_f64().unwrap() * er["flowM3h"].as_f64().unwrap();
            *net.get_mut(*from).unwrap() -= signed;
            *net.get_mut(*to).unwrap() += signed;
        }
        let mut worst = 0.0f64;
        let mut keys: Vec<&String> = net.keys().collect();
        keys.sort();
        for id in keys {
            let nf = net[id];
            println!("  NET FLOW  {:<7} = {:+.6} m3/h", id, nf);
            if id != ref_id && nf.abs() > worst {
                worst = nf.abs();
            }
        }
        for (id, nf) in net.iter() {
            if id == ref_id {
                continue;
            }
            assert!(
                nf.abs() < tol,
                "node {} net flow {:+.6} m3/h must be ~0 (< {}): mass not conserved",
                id,
                nf,
                tol
            );
        }
        worst
    }

    // (a) Simple loop: boiler -> pump -> radiator -> back to boiler.
    #[test]
    fn test_loop_energy_balance() {
        let nodes = vec![
            node("src", "source", &[("ratedKw", 24.0), ("maxSupplyC", 75.0)]),
            node("pmp", "pump", &[("h0Kpa", 45.0), ("qMaxM3h", 3.5)]),
            node(
                "rad",
                "emitter",
                &[
                    ("ratedKw", 24.0),
                    ("ratedExcessC", 50.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
        ];
        let edges = vec![
            edge("e1", "src", "sup", "pmp", "in", 5.0, 22.0),
            edge("e2", "pmp", "out", "rad", "sup", 5.0, 22.0),
            edge("e3", "rad", "ret", "src", "ret", 5.0, 22.0),
        ];
        let out = solve(&req_json(nodes, edges, 15.0));
        let v = parse(&out);
        println!("LOOP RESULT: {}", out);

        assert_eq!(v["status"], "converged", "status must be converged");
        let g = &v["global"];
        let heat = g["heatKw"].as_f64().unwrap();
        let supply = g["supplyC"].as_f64().unwrap();
        let ret = g["returnC"].as_f64().unwrap();
        let delta = g["deltaC"].as_f64().unwrap();
        let flow = g["flowM3h"].as_f64().unwrap();
        let src_heat = v["nodes"]["src"]["heatKw"].as_f64().unwrap();
        let rad_heat = v["nodes"]["rad"]["heatKw"].as_f64().unwrap();

        assert!(flow > 0.0, "flow must be positive, got {}", flow);
        assert!(supply > ret, "supply {} must exceed return {}", supply, ret);
        assert!(
            (3.0..=45.0).contains(&delta),
            "deltaC {} must be in 3..45",
            delta
        );
        assert!(heat > 0.0, "heat must be positive");
        // Source-measured vs emitter-measured heat. In a direct series loop these
        // differ by the model's intrinsic slack (each side measures heat against
        // its OWN inlet temperature; with a capped supply the gap settles ~11.5%,
        // exactly what the TS reference solver produces for this case).
        let rel = (src_heat - rad_heat).abs() / src_heat.max(1e-6);
        assert!(
            rel < 0.15,
            "source {} vs radiator {} differ by {:.1}% (>15%)",
            src_heat,
            rad_heat,
            rel * 100.0
        );
    }

    // (b) Tree: source -> buffer tank -> two radiators in parallel -> back.
    #[test]
    fn test_tree_energy_balance() {
        let nodes = vec![
            node("src", "source", &[("ratedKw", 18.0), ("maxSupplyC", 70.0)]),
            node("pmp", "pump", &[("h0Kpa", 50.0), ("qMaxM3h", 4.0)]),
            node("buf", "tank", &[("volumeL", 200.0)]),
            node(
                "rad1",
                "emitter",
                &[
                    ("ratedKw", 9.0),
                    ("ratedExcessC", 45.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
            node(
                "rad2",
                "emitter",
                &[
                    ("ratedKw", 9.0),
                    ("ratedExcessC", 45.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
            node("mix", "junction", &[("kKpa", 2.0)]),
        ];
        // buffer: pump feeds pri_in, returns from pri_out; loads off sec_out/sec_in
        let edges = vec![
            edge("e1", "src", "sup", "pmp", "in", 4.0, 28.0),
            edge("e2", "pmp", "out", "buf", "pri_in", 4.0, 28.0),
            edge("e3", "buf", "sec_out", "rad1", "sup", 6.0, 22.0),
            edge("e4", "buf", "sec_out", "rad2", "sup", 6.0, 22.0),
            edge("e5", "rad1", "ret", "mix", "pri_in", 6.0, 22.0),
            edge("e6", "rad2", "ret", "mix", "pri_out", 6.0, 22.0),
            edge("e7", "mix", "sec_out", "buf", "sec_in", 4.0, 28.0),
            edge("e8", "buf", "pri_out", "src", "ret", 4.0, 28.0),
        ];
        let out = solve(&req_json(nodes, edges, 15.0));
        let v = parse(&out);
        println!("TREE RESULT: {}", out);

        assert_eq!(v["status"], "converged");

        // ---- Mass conservation (the property the continuity-exact pass fixes) ----
        // The reference node is port 0 = `src:ret` (the source is the first node;
        // a source with no built-in pump creates `ret` then `sup`), so `src`
        // carries the slack and is excluded.
        let topo = [
            ("e1", "src", "pmp"),
            ("e2", "pmp", "buf"),
            ("e3", "buf", "rad1"),
            ("e4", "buf", "rad2"),
            ("e5", "rad1", "mix"),
            ("e6", "rad2", "mix"),
            ("e7", "mix", "buf"),
            ("e8", "buf", "src"),
        ];
        let worst = assert_node_continuity(&v, &topo, "src", 0.01);
        println!("TREE worst non-ref net flow = {:.6} m3/h", worst);

        // The single pump drives the PRIMARY loop (src -> buf -> src); that loop
        // carries a real circulation.
        let f_e2 = v["edges"]["e2"]["flowM3h"].as_f64().unwrap();
        let f_e8 = v["edges"]["e8"]["flowM3h"].as_f64().unwrap();
        assert!(f_e2 > 0.5, "primary feed e2 {} must circulate", f_e2);
        assert!(
            (f_e2 - f_e8).abs() < 0.01,
            "primary in {} == out {}",
            f_e2,
            f_e8
        );

        // NOTE: there is NO pump on the buffer's secondary side, so under true
        // continuity the parallel radiator taps (e3/e4) carry ~zero net flow and
        // the emitters stay cold. (The previous, non-conserving relaxed iterate
        // leaked spurious flow there and showed warm emitters — exactly the
        // mass-imbalance artifact this fix removes. The TS reference, post-fix,
        // produces the same cold secondaries.) We therefore assert the emitter
        // taps are essentially dead, not warm.
        for e in ["e3", "e4"] {
            let f = v["edges"][e]["flowM3h"].as_f64().unwrap();
            assert!(
                f < 0.01,
                "secondary tap {} flow {} must be ~0 (no secondary pump)",
                e,
                f
            );
        }

        // Buffer tank still reports its 6-layer stratification shape.
        let strat = v["nodes"]["buf"]["strat"].as_array().unwrap();
        assert_eq!(strat.len(), 6, "buffer must report 6 strat layers");
    }

    // Heat-pump COP path.
    #[test]
    fn test_heat_pump_cop() {
        let nodes = vec![
            node(
                "hp",
                "source",
                &[
                    ("ratedKw", 12.0),
                    ("maxSupplyC", 45.0),
                    ("sourceC", 7.0),
                    ("copRated", 4.2),
                ],
            ),
            node("pmp", "pump", &[("h0Kpa", 40.0), ("qMaxM3h", 3.0)]),
            node(
                "ufh",
                "emitter",
                &[
                    ("ratedKw", 12.0),
                    ("ratedExcessC", 15.0),
                    ("roomC", 21.0),
                    ("exponent", 1.1),
                ],
            ),
        ];
        let edges = vec![
            edge("e1", "hp", "sup", "pmp", "in", 5.0, 28.0),
            edge("e2", "pmp", "out", "ufh", "sup", 5.0, 28.0),
            edge("e3", "ufh", "ret", "hp", "ret", 5.0, 28.0),
        ];
        let out = solve(&req_json(nodes, edges, 15.0));
        let v = parse(&out);
        println!("HEATPUMP RESULT: {}", out);
        assert_eq!(v["status"], "converged");
        let cop = v["global"]["cop"].as_f64().unwrap();
        assert!(cop >= 1.5, "cop floored at 1.5, got {}", cop);
        assert!(cop < 8.0, "cop sane upper bound, got {}", cop);
        let node_cop = v["nodes"]["hp"]["cop"].as_f64().unwrap();
        assert!((node_cop - cop).abs() < 1e-6, "node cop mirrors global");
    }

    // Empty / no-pump network returns "empty" with zeroed flow.
    #[test]
    fn test_no_pump_empty() {
        let nodes = vec![
            node("src", "source", &[("ratedKw", 10.0), ("maxSupplyC", 60.0)]),
            node(
                "rad",
                "emitter",
                &[("ratedKw", 10.0), ("ratedExcessC", 50.0)],
            ),
        ];
        let edges = vec![
            edge("e1", "src", "sup", "rad", "sup", 5.0, 22.0),
            edge("e2", "rad", "ret", "src", "ret", 5.0, 22.0),
        ];
        let out = solve(&req_json(nodes, edges, 15.0));
        let v = parse(&out);
        assert_eq!(v["status"], "empty", "no pump -> empty");
        assert_eq!(v["edges"]["e1"]["flowM3h"].as_f64().unwrap(), 0.0);
    }

    // Malformed JSON -> error status, no panic.
    #[test]
    fn test_bad_json_error() {
        let out = solve("{not valid json");
        let v = parse(&out);
        assert_eq!(v["status"], "error");
        assert!(v["message"].as_str().unwrap().contains("parse"));
    }

    // Unknown `role` string -> deserialization ERROR (fail fast), NOT a silent
    // fallback to a converged `passive` solve. `Role` derives `Deserialize` with
    // `rename_all = "lowercase"` and NO `#[serde(other)]`, so serde rejects an
    // unrecognized variant; `solve()` then reports `status:"error"`, which the JS
    // worker treats as a signal to fall back to the trusted TS engine.
    #[test]
    fn test_unknown_role_errors() {
        // A complete, otherwise-valid request (a pump-driven loop) where ONE node
        // carries a bogus role. If the bad role were silently demoted to Passive
        // this network could converge — so a non-error result here is a real
        // regression, not merely an "empty" no-op.
        let nodes = vec![
            node("src", "source", &[("ratedKw", 24.0), ("maxSupplyC", 75.0)]),
            node("pmp", "pump", &[("h0Kpa", 45.0), ("qMaxM3h", 3.5)]),
            node("mystery", "frobnicate", &[]),
        ];
        let edges = vec![
            edge("e1", "src", "sup", "pmp", "in", 5.0, 22.0),
            edge("e2", "pmp", "out", "mystery", "in", 5.0, 22.0),
            edge("e3", "mystery", "out", "src", "ret", 5.0, 22.0),
        ];
        let out = solve(&req_json(nodes, edges, 15.0));
        let v = parse(&out);
        println!("UNKNOWN-ROLE RESULT: {}", out);

        assert_eq!(
            v["status"], "error",
            "an unknown role must fail the solve, not converge as passive"
        );
        assert_ne!(v["status"], "converged", "must NOT silently converge");
        // The failure originates in request-JSON deserialization.
        assert!(
            v["message"].as_str().unwrap().contains("parse"),
            "error message should report a request-parse failure, got: {:?}",
            v["message"]
        );
    }

    // ---- Regression: the app's seed topology (two sources, buffer + separator,
    //      three independently-pumped secondary loops). The old node-level model
    //      drove secondary loops below ambient; the relaxed-iterate hydraulics
    //      also failed to conserve mass. We now assert mass conservation at every
    //      non-reference node (the property the continuity-exact pass restores),
    //      no sub-ambient temps, and live primary circulation.
    #[test]
    fn test_seed_multi_pump_separator_mass_conserving() {
        let nodes = vec![
            node(
                "hp",
                "source",
                &[
                    ("ratedKw", 12.0),
                    ("maxSupplyC", 52.0),
                    ("sourceC", 7.0),
                    ("copRated", 4.2),
                ],
            ),
            node("dirt", "passive", &[("kKpa", 0.4)]),
            node("circ1", "pump", &[("h0Kpa", 45.0), ("qMaxM3h", 3.0)]),
            node("buf", "tank", &[("volumeL", 500.0)]),
            node("sep", "junction", &[("kKpa", 0.5)]),
            node("dg", "pump", &[("h0Kpa", 50.0), ("qMaxM3h", 2.2)]),
            node(
                "rad1",
                "emitter",
                &[
                    ("ratedKw", 2.4),
                    ("ratedExcessC", 50.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
            node(
                "rad2",
                "emitter",
                &[
                    ("ratedKw", 1.8),
                    ("ratedExcessC", 50.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
            node(
                "mg",
                "pump",
                &[("h0Kpa", 50.0), ("qMaxM3h", 2.4), ("targetSupplyC", 38.0)],
            ),
            node(
                "uf",
                "emitter",
                &[
                    ("ratedKw", 4.5),
                    ("ratedExcessC", 15.0),
                    ("roomC", 21.0),
                    ("exponent", 1.1),
                ],
            ),
            node("dhwg", "pump", &[("h0Kpa", 50.0), ("qMaxM3h", 1.6)]),
            node(
                "dhw",
                "tank",
                &[("volumeL", 200.0), ("setpointC", 50.0), ("standbyKw", 1.2)],
            ),
            node(
                "boiler",
                "source",
                &[("ratedKw", 24.0), ("maxSupplyC", 72.0)],
            ),
            node("circ2", "pump", &[("h0Kpa", 50.0), ("qMaxM3h", 2.6)]),
            node("exp", "passive", &[("volumeL", 18.0)]),
            node("air", "passive", &[]),
        ];
        let pri = 28.0;
        let sec = 22.0;
        let mic = 18.0;
        let edges = vec![
            // primary: heat pump -> dirt -> circ1 -> buffer -> back
            edge("p1", "hp", "sup", "dirt", "in", 4.0, pri),
            edge("p2", "dirt", "out", "circ1", "in", 2.0, pri),
            edge("p3", "circ1", "out", "buf", "pri_in", 4.0, pri),
            edge("p4", "buf", "pri_out", "hp", "ret", 6.0, pri),
            // gas boiler branch into buffer
            edge("p5", "boiler", "sup", "circ2", "in", 4.0, pri),
            edge("p6", "circ2", "out", "buf", "pri_in", 5.0, pri),
            edge("p7", "buf", "pri_out", "boiler", "ret", 6.0, pri),
            // buffer <-> separator
            edge("p8", "buf", "sec_out", "sep", "pri_in", 3.0, sec),
            edge("p9", "sep", "pri_out", "buf", "sec_in", 3.0, sec),
            // radiators (direct group), two in parallel
            edge("p10", "sep", "sec_out", "dg", "in", 3.0, sec),
            edge("p11", "dg", "out", "rad1", "sup", 5.0, sec),
            edge("p12", "rad1", "ret", "sep", "sec_in", 6.0, sec),
            edge("p13", "dg", "out", "rad2", "sup", 5.0, sec),
            edge("p14", "rad2", "ret", "sep", "sec_in", 6.0, sec),
            // underfloor (mixing group)
            edge("p15", "sep", "sec_out", "mg", "in", 3.0, sec),
            edge("p16", "mg", "out", "uf", "sup", 6.0, sec),
            edge("p17", "uf", "ret", "sep", "sec_in", 7.0, sec),
            // DHW cylinder loop
            edge("p18", "sep", "sec_out", "dhwg", "in", 4.0, mic),
            edge("p19", "dhwg", "out", "dhw", "sup", 5.0, mic),
            edge("p20", "dhw", "ret", "sep", "sec_in", 6.0, mic),
            // safety taps (dead legs)
            edge("p21", "exp", "tap", "buf", "pri_out", 2.0, mic),
            edge("p22", "air", "tap", "sep", "sec_out", 2.0, mic),
        ];
        let out = solve(&req_json(nodes, edges, 20.0));
        let v = parse(&out);
        println!("SEED RESULT: {}", out);

        let ambient = 20.0;
        assert_eq!(v["status"], "converged", "seed must converge");

        // ---- Mass conservation: the core property the continuity-exact final
        // hydraulic pass guarantees. With the OLD relaxed-iterate flow the signed
        // per-node sums were off by a few percent (the imbalance piled onto the
        // slack node); the fix makes every non-reference node conserve mass. The
        // reference node is port 0 = `hp:ret` (the heat pump is the first node and,
        // having a built-in pump, creates `ret` then `sup`), so `hp` carries the
        // residual slack and is excluded.
        let topo = [
            ("p1", "hp", "dirt"),
            ("p2", "dirt", "circ1"),
            ("p3", "circ1", "buf"),
            ("p4", "buf", "hp"),
            ("p5", "boiler", "circ2"),
            ("p6", "circ2", "buf"),
            ("p7", "buf", "boiler"),
            ("p8", "buf", "sep"),
            ("p9", "sep", "buf"),
            ("p10", "sep", "dg"),
            ("p11", "dg", "rad1"),
            ("p12", "rad1", "sep"),
            ("p13", "dg", "rad2"),
            ("p14", "rad2", "sep"),
            ("p15", "sep", "mg"),
            ("p16", "mg", "uf"),
            ("p17", "uf", "sep"),
            ("p18", "sep", "dhwg"),
            ("p19", "dhwg", "dhw"),
            ("p20", "dhw", "sep"),
            ("p21", "exp", "buf"),
            ("p22", "air", "sep"),
        ];
        let worst = assert_node_continuity(&v, &topo, "hp", 0.01);
        println!("SEED worst non-ref net flow = {:.6} m3/h", worst);

        // The two primary circulators drive real circulation through the buffer.
        for (eid, lbl) in [("p3", "hp-circ1->buf"), ("p6", "boiler-circ2->buf")] {
            let f = v["edges"][eid]["flowM3h"].as_f64().unwrap();
            assert!(
                f > 0.5,
                "primary feed {} ({}) must circulate, got {}",
                eid,
                lbl,
                f
            );
        }

        // No node or edge temp below ambient-2 (no spurious sub-ambient cooling —
        // the original node-level bug that drove secondary loops below ambient).
        for (id, nr) in v["nodes"].as_object().unwrap() {
            for key in ["supplyC", "returnC"] {
                if let Some(t) = nr.get(key).and_then(|x| x.as_f64()) {
                    assert!(
                        t >= ambient - 2.0,
                        "node {} {} = {} below ambient-2",
                        id,
                        key,
                        t
                    );
                }
            }
        }
        for (id, er) in v["edges"].as_object().unwrap() {
            let t = er["tempC"].as_f64().unwrap();
            assert!(t >= ambient - 2.0, "edge {} temp {} below ambient-2", id, t);
        }

        // NOTE (was `..._warm_secondaries`): this topology dead-heads the buffer
        // against the separator — the buffer<->separator link (p8/p9) has no net
        // pressure differential, so under TRUE continuity it carries ~zero flow
        // and the separator-fed secondaries circulate locally but cold. The OLD,
        // non-conserving relaxed iterate leaked spurious flow across p8/p9 and so
        // showed warm secondaries; that warmth was a mass-imbalance ARTIFACT. The
        // post-fix TS reference produces exactly these cold secondaries too. We
        // therefore assert the link is essentially dead rather than warm.
        for e in ["p8", "p9"] {
            let f = v["edges"][e]["flowM3h"].as_f64().unwrap();
            assert!(
                f < 0.01,
                "buffer<->separator link {} flow {} must be ~0 (dead-headed; no net dP)",
                e,
                f
            );
        }
    }

    // 4-port pump group (NEW role). Two independent loops sharing the request:
    //   source -> separator(junction) -> group.pri_in / group.pri_out
    //   group.sec_out -> emitter -> group.sec_in
    // `dg` is a DIRECT group (sec_out should track pri_in temp); `mg` is a
    // MIXING group with targetSupplyC=38 (sec_out should clamp to ~38 when the
    // primary is hotter). The group's own pump branch drives each loop.
    #[test]
    fn test_group_direct_and_mixing() {
        let nodes = vec![
            // ---- direct group loop ----
            node("srcD", "source", &[("ratedKw", 24.0), ("maxSupplyC", 70.0)]),
            node("sepD", "junction", &[("kKpa", 0.5)]),
            node("dg", "group", &[("h0Kpa", 50.0), ("qMaxM3h", 2.4)]),
            node(
                "radD",
                "emitter",
                &[
                    ("ratedKw", 2.4),
                    ("ratedExcessC", 50.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
            // ---- mixing group loop (target 38) ----
            // Hotter, lower-flow primary so pri_in clearly exceeds the 38C target
            // and the mixing clamp is actually exercised.
            node("srcM", "source", &[("ratedKw", 40.0), ("maxSupplyC", 70.0)]),
            node("sepM", "junction", &[("kKpa", 0.5)]),
            node(
                "mg",
                "group",
                &[("h0Kpa", 50.0), ("qMaxM3h", 1.2), ("targetSupplyC", 38.0)],
            ),
            node(
                "ufM",
                "emitter",
                &[
                    ("ratedKw", 4.5),
                    ("ratedExcessC", 15.0),
                    ("roomC", 21.0),
                    ("exponent", 1.1),
                ],
            ),
        ];
        let pri = 26.0;
        let sec = 22.0;
        // Series primary loop driven by the group's own pump: the source feeds
        // the group's primary inlet THROUGH the separator (an inline pass-through
        // junction), the group's primary outlet returns to the source, and the
        // group's secondary serves the emitter. One pump (the group) circulates
        // the whole loop, so the source sees full flow and heats the primary.
        let edges = vec![
            // direct group loop
            edge("d1", "srcD", "sup", "sepD", "in", 3.0, pri),
            edge("d2", "sepD", "out", "dg", "pri_in", 3.0, pri),
            edge("d3", "dg", "pri_out", "srcD", "ret", 3.0, pri),
            edge("d5", "dg", "sec_out", "radD", "sup", 5.0, sec),
            edge("d6", "radD", "ret", "dg", "sec_in", 6.0, sec),
            // mixing group loop, same shape (target 38)
            edge("m1", "srcM", "sup", "sepM", "in", 3.0, pri),
            edge("m2", "sepM", "out", "mg", "pri_in", 3.0, pri),
            edge("m3", "mg", "pri_out", "srcM", "ret", 3.0, pri),
            edge("m5", "mg", "sec_out", "ufM", "sup", 6.0, sec),
            edge("m6", "ufM", "ret", "mg", "sec_in", 7.0, sec),
        ];
        let out = solve(&req_json(nodes, edges, 18.0));
        let v = parse(&out);
        println!("GROUP RESULT: {}", out);

        assert_eq!(v["status"], "converged", "group network must converge");

        // ---- DIRECT group: sec_out (supplyC) ~= primary supply temp (pri_in). ----
        // The group's primary inlet equals the source supply (the separator is a
        // near-lossless pass-through), so the direct group passes that through to
        // its secondary supply.
        let dg_sup = v["nodes"]["dg"]["supplyC"].as_f64().unwrap();
        let src_d_sup = v["nodes"]["srcD"]["supplyC"].as_f64().unwrap();
        assert!(
            (dg_sup - src_d_sup).abs() < 1.5,
            "direct group sec_out {} must track pri_in/source supply {} (within 1.5C)",
            dg_sup,
            src_d_sup
        );
        assert!(dg_sup > 25.0, "direct group supply {} must be warm", dg_sup);

        // ---- MIXING group: sec_out clamps to the 38C target (pri_in is hotter). ----
        let mg_sup = v["nodes"]["mg"]["supplyC"].as_f64().unwrap();
        let src_m_sup = v["nodes"]["srcM"]["supplyC"].as_f64().unwrap();
        assert!(
            src_m_sup > 40.0,
            "mixing-loop source supply {} should exceed the 38C target (else test is vacuous)",
            src_m_sup
        );
        assert!(
            (mg_sup - 38.0).abs() < 1.0,
            "mixing group sec_out {} must clamp to target 38C (within 1C)",
            mg_sup
        );
        // Mixing group reports a blend position in (0,100].
        let vp = v["nodes"]["mg"]["valvePct"].as_f64().unwrap();
        assert!(
            (0.0..=100.0).contains(&vp),
            "mixing valvePct {} in [0,100]",
            vp
        );

        // ---- Energy balance across each group: the heat handed to the secondary
        //      (mdot*cp*(sec_out - sec_in)) must match the heat drawn from the
        //      primary (mdot*cp*(pri_in - pri_out)). We read it via the group's
        //      reported heatKw (secondary side) against the primary-side drop
        //      reconstructed from the loop temps. ----
        for grp in ["dg", "mg"] {
            let n = &v["nodes"][grp];
            let q_sec = n["heatKw"].as_f64().unwrap(); // mdot*cp*(secOut-secIn)/1000
            let sec_out = n["supplyC"].as_f64().unwrap();
            let sec_in = n["returnC"].as_f64().unwrap();
            // primary drop = (secOut - secIn) by construction of the group thermal
            // rule (tPriOut = tPriIn - (tSecOut - tSecIn) for mixing; for direct
            // tPriOut = tSecIn and tPriIn = tSecOut, so the same identity holds).
            // So the primary-side heat equals the secondary-side heat exactly when
            // their mdots match — which they do (one series loop). Assert the
            // group conserves energy: |q_sec| reconstructed from its own temps.
            let span = sec_out - sec_in;
            assert!(
                q_sec >= 0.0,
                "group {} secondary heat {} must be >= 0 (sec_out {} >= sec_in {})",
                grp,
                q_sec,
                sec_out,
                sec_in
            );
            // Energy balance: primary delta (pri_in - pri_out) equals secondary
            // delta (sec_out - sec_in) within 5% — the defining property of the
            // group. We verify via the temperature identity the solver enforces.
            // For the DIRECT group pri_in==sec_out and pri_out==sec_in so the two
            // spans are identical; for MIXING the rule sets pri_out = pri_in-span,
            // i.e. primary span == secondary span by construction.
            // Cross-check numerically against the loop edges feeding the group.
            let pri_in_edge = if grp == "dg" { "d2" } else { "m2" }; // sep.out -> group.pri_in
            let pri_out_edge = if grp == "dg" { "d3" } else { "m3" }; // group.pri_out -> source.ret
            let t_pri_in = v["edges"][pri_in_edge]["tempC"].as_f64().unwrap();
            let t_pri_out = v["edges"][pri_out_edge]["tempC"].as_f64().unwrap();
            let pri_span = t_pri_in - t_pri_out;
            let rel = (pri_span - span).abs() / span.abs().max(0.5);
            println!(
                "GROUP {} : sec_out={:.2} sec_in={:.2} sec_span={:.2} | pri_in={:.2} pri_out={:.2} pri_span={:.2} | rel={:.1}% q_sec={:.3}kW",
                grp, sec_out, sec_in, span, t_pri_in, t_pri_out, pri_span, rel * 100.0, q_sec
            );
            assert!(
                rel < 0.05,
                "group {} energy balance off: primary span {:.3} vs secondary span {:.3} ({:.1}% > 5%)",
                grp, pri_span, span, rel * 100.0
            );
        }
    }

    // Energy-balanced 2-zone STRATIFIED buffer tank (role `tank`, NO setpointC).
    //   charge: heat-pump(built-in pump) -> buffer top (l0, supply)
    //           buffer bottom (l1, return) -> heat-pump return
    //   load:   buffer top (r0, supply) -> load pump -> radiator -> buffer
    //           bottom (r1, return)
    // The buffer must stratify: top (hot/supply side) strictly above bottom
    // (cool/return side), top near the HP supply, and energy conserved across
    // the tank (fs*chargeT + fl*retT == fl*top + fs*bot, to within 1%).
    #[test]
    fn test_stratified_buffer_two_zone() {
        let nodes = vec![
            // heat pump with its OWN circulator (h0Kpa present) drives the charge loop
            node(
                "hp",
                "source",
                &[
                    ("ratedKw", 14.0),
                    ("maxSupplyC", 52.0),
                    ("h0Kpa", 50.0),
                    ("qMaxM3h", 2.4),
                ],
            ),
            // buffer tank: NO setpointC -> 2-zone stratified model
            node("buf", "tank", &[("volumeL", 300.0)]),
            // load-loop circulator (lower flow -> bigger load ΔT, colder return)
            node("lp", "pump", &[("h0Kpa", 45.0), ("qMaxM3h", 1.0)]),
            node(
                "rad",
                "emitter",
                &[
                    ("ratedKw", 11.0),
                    ("ratedExcessC", 20.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
        ];
        let edges = vec![
            // charge loop: HP supply -> buffer top (supply); buffer bottom -> HP return
            edge_line("c1", "hp", "sup", "buf", "l0", 3.0, 28.0, "supply"),
            edge_line("c2", "buf", "l1", "hp", "ret", 3.0, 28.0, "return"),
            // load loop: buffer top -> pump -> radiator -> buffer bottom
            edge_line("l1", "buf", "r0", "lp", "in", 2.0, 22.0, "supply"),
            edge_line("l2", "lp", "out", "rad", "sup", 4.0, 22.0, "supply"),
            edge_line("l3", "rad", "ret", "buf", "r1", 4.0, 22.0, "return"),
        ];
        let out = solve(&req_json(nodes, edges, 15.0));
        let v = parse(&out);
        println!("STRAT BUFFER RESULT: {}", out);

        assert_eq!(
            v["status"], "converged",
            "stratified buffer net must converge"
        );

        let top = v["nodes"]["buf"]["supplyC"].as_f64().unwrap();
        let bot = v["nodes"]["buf"]["returnC"].as_f64().unwrap();
        let hp_sup = v["nodes"]["hp"]["supplyC"].as_f64().unwrap();
        let strat = v["nodes"]["buf"]["strat"].as_array().unwrap();
        println!(
            "STRAT: top={:.2} bot={:.2} hp_supply={:.2} strat={:?}",
            top,
            bot,
            hp_sup,
            strat
                .iter()
                .map(|x| x.as_f64().unwrap())
                .collect::<Vec<_>>()
        );

        // 6-layer gradient, hot top first, cold bottom last.
        assert_eq!(strat.len(), 6, "buffer must report 6 strat layers");
        assert!(
            (strat[0].as_f64().unwrap() - top).abs() < 0.06,
            "strat top {} must equal supplyC {}",
            strat[0],
            top
        );
        assert!(
            (strat[5].as_f64().unwrap() - bot).abs() < 0.06,
            "strat bottom {} must equal returnC {}",
            strat[5],
            bot
        );

        // STRATIFIED: top strictly hotter than bottom by a few degrees (NOT a
        // well-mixed junction where top == bot).
        assert!(
            top > bot + 2.0,
            "buffer must stratify: top {} should exceed bottom {} by >2C",
            top,
            bot
        );

        // The hot top is fed by the HP charge, so it should sit near the HP supply.
        assert!(
            (top - hp_sup).abs() < 3.0,
            "buffer top {} should track HP supply {} (within 3C)",
            top,
            hp_sup
        );

        // ---- Energy balance across the tank ----
        // Reconstruct charge/return flows + temps from the solved edges and check
        // fs*chargeT + fl*retT == fl*top + fs*bot (the model's exact identity).
        // c1 carries the hot charge INTO the top; l3 carries the cool load return
        // INTO the bottom. Mass flows are read from |edge flow|.
        let charge_flow = v["edges"]["c1"]["flowM3h"].as_f64().unwrap();
        let charge_t = v["edges"]["c1"]["tempC"].as_f64().unwrap();
        let ret_flow = v["edges"]["l3"]["flowM3h"].as_f64().unwrap();
        let ret_t = v["edges"]["l3"]["tempC"].as_f64().unwrap();
        let fs = charge_flow.max(1e-9);
        let fl = ret_flow.max(1e-9);
        let e_in = fs * charge_t + fl * ret_t;
        let e_out = fl * top + fs * bot;
        let rel = (e_in - e_out).abs() / e_in.max(1e-6);
        println!(
            "ENERGY(tank): charge_flow={:.4} charge_t={:.2} | ret_flow={:.4} ret_t={:.2} | e_in={:.3} e_out={:.3} rel={:.2}%",
            charge_flow, charge_t, ret_flow, ret_t, e_in, e_out, rel * 100.0
        );
        assert!(
            charge_flow > 1e-3 && ret_flow > 1e-3,
            "both charge ({:.4}) and load-return ({:.4}) flows must be active",
            charge_flow,
            ret_flow
        );
        assert!(
            rel < 0.01,
            "tank energy balance off: in {:.4} vs out {:.4} ({:.2}% > 1%)",
            e_in,
            e_out,
            rel * 100.0
        );
    }

    // ---- Mass conservation: the final continuity-exact flow pass must make the
    //      signed sum of edge flows at EVERY non-reference node vanish, and a
    //      series path must carry one and the same flow end to end.
    //   charge: heat-pump(built-in pump, h0 50 / qMax 2.4) -> dirt -> buffer top
    //           (l0, supply); buffer bottom (l1, return) -> heat-pump return
    //   load:   buffer top (r0, supply) -> load pump -> radiator -> buffer
    //           bottom (r1, return)
    // The reference port is port 0 (the first port created = `hp:ret`), so the
    // heat-pump node carries the slack and is excluded from the per-node check.
    #[test]
    fn test_mass_conservation() {
        let nodes = vec![
            // heat pump with its OWN circulator (h0Kpa present) drives the charge loop
            node(
                "hp",
                "source",
                &[
                    ("ratedKw", 14.0),
                    ("maxSupplyC", 52.0),
                    ("h0Kpa", 50.0),
                    ("qMaxM3h", 2.4),
                ],
            ),
            // inline dirt separator on the charge path (series with hp.sup)
            node("dirt", "passive", &[("kKpa", 0.4)]),
            // buffer tank: NO setpointC -> 2-zone stratified model
            node("buf", "tank", &[("volumeL", 300.0)]),
            // load-loop circulator (lower flow -> distinct from charge flow)
            node("lp", "pump", &[("h0Kpa", 45.0), ("qMaxM3h", 1.0)]),
            node(
                "rad",
                "emitter",
                &[
                    ("ratedKw", 11.0),
                    ("ratedExcessC", 20.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
        ];
        let edges = vec![
            // charge loop: HP supply -> dirt -> buffer top (supply, l0);
            //              buffer bottom (l1, return) -> HP return
            edge_line("c1", "hp", "sup", "dirt", "in", 3.0, 28.0, "supply"),
            edge_line("c2", "dirt", "out", "buf", "l0", 3.0, 28.0, "supply"),
            edge_line("c3", "buf", "l1", "hp", "ret", 3.0, 28.0, "return"),
            // load loop: buffer top (r0) -> pump -> radiator -> buffer bottom (r1)
            edge_line("l1", "buf", "r0", "lp", "in", 2.0, 22.0, "supply"),
            edge_line("l2", "lp", "out", "rad", "sup", 4.0, 22.0, "supply"),
            edge_line("l3", "rad", "ret", "buf", "r1", 4.0, 22.0, "return"),
        ];
        let out = solve(&req_json(nodes, edges, 15.0));
        let v = parse(&out);
        println!("MASS-CONSERVATION RESULT: {}", out);

        assert_eq!(
            v["status"], "converged",
            "mass-conservation net must converge"
        );

        // Signed net flow at every node from the reported edges: a flow along an
        // edge (source->target, sign = dir*flowM3h) LEAVES its `from` node (−) and
        // ENTERS its `to` node (+). Continuity => the signed sum is ~0 at every
        // non-reference node (the reference port's node, `hp`, carries the slack).
        let edges_obj = v["edges"].as_object().unwrap();
        let req_edges = [
            ("c1", "hp", "dirt"),
            ("c2", "dirt", "buf"),
            ("c3", "buf", "hp"),
            ("l1", "buf", "lp"),
            ("l2", "lp", "rad"),
            ("l3", "rad", "buf"),
        ];
        let mut net_flow: HashMap<&str, f64> = HashMap::new();
        for nid in ["hp", "dirt", "buf", "lp", "rad"] {
            net_flow.insert(nid, 0.0);
        }
        for (eid, from, to) in req_edges.iter() {
            let er = &edges_obj[*eid];
            let f = er["flowM3h"].as_f64().unwrap();
            let dir = er["dir"].as_f64().unwrap();
            let signed = dir * f; // along source->target
            *net_flow.get_mut(*from).unwrap() -= signed; // leaves `from`
            *net_flow.get_mut(*to).unwrap() += signed; // enters `to`
        }
        for (nid, nf) in net_flow.iter() {
            println!("NET FLOW  {:<5} = {:+.6} m3/h", nid, nf);
        }
        // The reference node (`hp`) is excluded — it absorbs the (now negligible)
        // numerical slack. Every OTHER node must conserve mass to < 0.01 m3/h.
        for nid in ["dirt", "buf", "lp", "rad"] {
            let nf = net_flow[nid];
            assert!(
                nf.abs() < 0.01,
                "node {} net flow {:+.6} m3/h must be ~0 (mass not conserved)",
                nid,
                nf
            );
        }
        // The reference node should ALSO close tightly now that the final pass is
        // continuity-exact (it is no longer the dumping ground for a few-percent
        // imbalance). Allow the same tolerance.
        assert!(
            net_flow["hp"].abs() < 0.01,
            "reference node hp net flow {:+.6} m3/h must be ~0 too",
            net_flow["hp"]
        );

        // Series charge path hp.sup -> dirt -> buf.l0 (edges c1, c2) and the
        // return leg buf.l1 -> hp.ret (c3) must all carry ONE flow within 0.01.
        let f_c1 = edges_obj["c1"]["flowM3h"].as_f64().unwrap();
        let f_c2 = edges_obj["c2"]["flowM3h"].as_f64().unwrap();
        let f_c3 = edges_obj["c3"]["flowM3h"].as_f64().unwrap();
        println!(
            "SERIES  hp.sup(c1)={:.4}  dirt.out(c2)={:.4}  buf.l1->hp.ret(c3)={:.4}",
            f_c1, f_c2, f_c3
        );
        assert!(
            (f_c1 - f_c2).abs() < 0.01 && (f_c2 - f_c3).abs() < 0.01,
            "series charge path must carry equal flow: c1 {:.4}, c2 {:.4}, c3 {:.4}",
            f_c1,
            f_c2,
            f_c3
        );
        // And it must be a real, nonzero circulation.
        assert!(
            f_c1 > 0.1,
            "charge flow {:.4} must be a real circulation",
            f_c1
        );
    }

    // ---- Manifold (NEW role): supply rail and return rail must stay SEPARATE.
    //   heat_pump(built-in pump) -> manifold.sup_in (supply)
    //   manifold.sup0 -> rad1.sup ; rad1.ret -> manifold.ret0 (circuit 1)
    //   manifold.sup1 -> rad2.sup ; rad2.ret -> manifold.ret1 (circuit 2)
    //   manifold.ret_out -> hp.ret (return)
    // A junction would mix all ports into one star: the hot supply would short-
    // circuit straight to the return inside the body, the circuits would get ~0
    // flow, and the supply temp would drop. A manifold instead builds TWO stars
    // (a supply rail + a return rail) so flow MUST travel out through the
    // circuits and back. Assert: converged; the manifold supplyC reaches the HP
    // supply (~52, NOT a cold ~27); BOTH circuits carry real flow (>0.1 m3/h, no
    // short-circuit); per-node mass conserves (<0.01). (TS oracle: manifold
    // sup~52 ret~49.7, rad1 sup 52 / kW 2.4, circuit flows ~0.8 each.)
    #[test]
    fn test_manifold_supply_not_mixed() {
        let nodes = vec![
            node(
                "hp",
                "source",
                &[
                    ("ratedKw", 14.0),
                    ("maxSupplyC", 52.0),
                    ("h0Kpa", 50.0),
                    ("qMaxM3h", 2.4),
                ],
            ),
            node("man", "manifold", &[("circuits", 2.0)]),
            node(
                "rad1",
                "emitter",
                &[
                    ("ratedKw", 4.0),
                    ("ratedExcessC", 45.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
            node(
                "rad2",
                "emitter",
                &[
                    ("ratedKw", 3.0),
                    ("ratedExcessC", 45.0),
                    ("roomC", 20.0),
                    ("exponent", 1.3),
                ],
            ),
        ];
        let edges = vec![
            // HP supply -> manifold supply rail inlet
            edge_line("e1", "hp", "sup", "man", "sup_in", 3.0, 28.0, "supply"),
            // circuit 1: manifold supply tap -> rad1 -> manifold return tap
            edge_line("e2", "man", "sup0", "rad1", "sup", 4.0, 16.0, "supply"),
            edge_line("e3", "rad1", "ret", "man", "ret0", 4.0, 16.0, "return"),
            // circuit 2: manifold supply tap -> rad2 -> manifold return tap
            edge_line("e4", "man", "sup1", "rad2", "sup", 4.0, 16.0, "supply"),
            edge_line("e5", "rad2", "ret", "man", "ret1", 4.0, 16.0, "return"),
            // manifold return rail outlet -> HP return
            edge_line("e6", "man", "ret_out", "hp", "ret", 3.0, 28.0, "return"),
        ];
        let out = solve(&req_json(nodes, edges, 15.0));
        let v = parse(&out);
        println!("MANIFOLD RESULT: {}", out);

        assert_eq!(v["status"], "converged", "manifold net must converge");

        let man_sup = v["nodes"]["man"]["supplyC"].as_f64().unwrap();
        let man_ret = v["nodes"]["man"]["returnC"].as_f64().unwrap();
        let hp_sup = v["nodes"]["hp"]["supplyC"].as_f64().unwrap();
        println!(
            "MANIFOLD: sup={:.2} ret={:.2} hp_sup={:.2}",
            man_sup, man_ret, hp_sup
        );

        // The manifold supply rail must reach the HP supply (NOT a cold ~27 from
        // hot/return mixing). HP is capped at 52C, so supply should sit near it.
        assert!(
            hp_sup > 45.0,
            "HP supply {} should be near its 52C cap (else test is vacuous)",
            hp_sup
        );
        assert!(
            (man_sup - hp_sup).abs() < 3.0,
            "manifold supply {} must track HP supply {} (within 3C), NOT mix down to a cold ~27",
            man_sup,
            hp_sup
        );
        assert!(
            man_sup > 45.0,
            "manifold supply {} must be WARM (>45), not short-circuited to ~27",
            man_sup
        );
        // Return rail strictly cooler than supply (the two rails are distinct).
        assert!(
            man_sup > man_ret + 0.5,
            "manifold supply {} must exceed return {} (rails are separate)",
            man_sup,
            man_ret
        );

        // BOTH radiator circuits must carry REAL flow — if the supply short-
        // circuited to the return inside the body, the circuits would starve.
        let f_e2 = v["edges"]["e2"]["flowM3h"].as_f64().unwrap(); // circuit 1 supply
        let f_e4 = v["edges"]["e4"]["flowM3h"].as_f64().unwrap(); // circuit 2 supply
        println!("CIRCUIT FLOWS: rad1(e2)={:.4} rad2(e4)={:.4}", f_e2, f_e4);
        assert!(
            f_e2 > 0.1,
            "circuit 1 (rad1) flow {:.4} must be a real circulation (>0.1), no short-circuit",
            f_e2
        );
        assert!(
            f_e4 > 0.1,
            "circuit 2 (rad2) flow {:.4} must be a real circulation (>0.1), no short-circuit",
            f_e4
        );

        // Per-node mass conservation (<0.01). Reference port is port 0 = `hp:ret`
        // (the heat pump is the first node and, having a built-in pump, creates
        // `ret` then `sup`), so `hp` carries the slack and is excluded.
        let topo = [
            ("e1", "hp", "man"),
            ("e2", "man", "rad1"),
            ("e3", "rad1", "man"),
            ("e4", "man", "rad2"),
            ("e5", "rad2", "man"),
            ("e6", "man", "hp"),
        ];
        let worst = assert_node_continuity(&v, &topo, "hp", 0.01);
        println!("MANIFOLD worst non-ref net flow = {:.6} m3/h", worst);
    }
}

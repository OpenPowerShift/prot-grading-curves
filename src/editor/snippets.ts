/**
 * Snippet catalogue for the `.ptc` editor.
 *
 * Each snippet expands a block keyword into a skeleton carrying its
 * *required* fields, so the shape a new author types is valid by
 * construction rather than by trial and error. Optional fields are
 * left out deliberately -- a skeleton that has to be pruned teaches
 * less than one that has to be extended.
 *
 * `#{n}` markers are CodeMirror snippet field placeholders; `#{}`
 * marks where the cursor lands last.
 */

import { snippetCompletion, type Completion } from '@codemirror/autocomplete';

export interface SnippetSpec {
  /** Text the user types to reach this snippet. */
  prefix: string;
  /** Template, in CodeMirror snippet syntax. */
  template: string;
  /** One-line description shown in the completion list. */
  detail: string;
}

export const SNIPPETS: SnippetSpec[] = [
  {
    prefix: 'meta',
    detail: 'study metadata block',
    template: `meta {
    project   = "#{project}";
    study     = "#{study}";
    engineer  = "#{engineer}";
    date      = "#{yyyy-mm-dd}";
    margin    = #{0.30 s};
}#{}`,
  },
  {
    prefix: 'system',
    detail: 'system block with named voltage levels',
    template: `system {
    voltages {
        "#{HV}" { V  = #{33.0 kV}; description = "#{HV side}"; }
        "#{LV}" { V  = #{11.0 kV}; description = "#{LV side}"; }
    }
    base_S       = #{25.0 MVA};
}#{}`,
  },
  {
    prefix: 'faults',
    detail: 'fault-level table',
    template: `faults {
    "#{F_max}" { I   = #{6.40 A}; voltage = "#{LV}"; }
    "#{F_min}" { I   = #{2.50 A}; voltage = "#{LV}"; }
}#{}`,
  },
  {
    prefix: 'relay',
    detail: 'relay block with one IDMT element',
    template: `relay #{R_FDR_1} {
    maker    = "#{ABB}";
    model    = "#{REL_615}";
    voltage  = "#{LV}";
    ct_ratio = #{600}/#{5};

    element #{51} {
        function = "phase_oc";
        curve    = #{iec.si};
        I_pickup = #{480 A};
        tms      = #{0.30};
    }
}#{}`,
  },
  {
    prefix: 'element',
    detail: 'inverse-time overcurrent element',
    template: `element #{51} {
    function = "phase_oc";
    curve    = #{iec.si};
    I_pickup = #{480 A};
    tms      = #{0.30};
}#{}`,
  },
  {
    prefix: 'element-definite',
    detail: 'definite-time (instantaneous) element',
    template: `element #{50} {
    function = "phase_oc";
    curve    = definite;
    I_pickup = #{4000 A};
    t_delay  = #{0.10} s;
}#{}`,
  },
  {
    prefix: 'stages',
    detail: 'multi-stage element (IDMT low-set + definite high-set)',
    template: `element #{51} {
    function = "phase_oc";
    stages {
        stage #{main} {
            curve = #{iec.si};
            I_pickup = #{400 A};
            tms   = #{0.35};
        }
        stage #{inst} {
            curve   = definite;
            I_pickup = #{4500 A};
            t_delay = #{0.08} s;
        }
    }
}#{}`,
  },
  {
    prefix: 'grade',
    detail: 'grading pair with a CTI constraint',
    template: `grade {
    primary   = #{R_FDR_1}:#{51};
    backup    = #{R_TRF_INC}:#{51};
    fault     = "#{F_FDR1_max}";
    margin    = #{0.30 s};
}#{}`,
  },
  {
    prefix: 'grade-solve',
    detail: 'grading pair that solves the backup tms',
    template: `grade {
    primary  = #{R_FDR_1}:#{51};
    backup   = #{R_TRF_INC}:#{51};
    fault    = "#{F_FDR1_max}";
    margin_target = #{0.30 s};

    solve {
        strategy      = "#{tight}";
        tolerance_pct = #{5};
    }
}#{}`,
  },
  {
    prefix: 'device-fuse',
    detail: 'fuse with a min-melt / total-clear band',
    template: `device "#{fuse_100a}" {
    kind        = "fuse";
    rating_I    = #{100 A};
    min_melt    = [(#{150} A, #{100} s), (#{300} A, #{1.5} s), (#{1000} A, #{0.05} s)];
    total_clear = [(#{150} A, #{60} s), (#{300} A, #{0.6} s), (#{1000} A, #{0.02} s)];
}#{}`,
  },
  {
    prefix: 'combine',
    detail: 'synthetic curve from existing elements',
    template: `combine {
    name    = "#{A_OR_B}";
    sources = [#{R_FDR_1}:#{51}, #{R_TRF_INC}:#{51}];
    as      = "#{envelope_min}";
    style   = "dashed";
}#{}`,
  },
  {
    prefix: 'view',
    detail: 'display directives',
    template: `view {
    stages   = "#{composite}";
    axis     = "#{primary}";
    voltage  = "#{HV}";
}#{}`,
  },
  {
    prefix: 'page',
    detail: 'page geometry and theme',
    template: `page {
    size        = "#{A4}";
    orientation = "#{landscape}";
    theme       = "#{light}";
    title       = "#{Study title}";
}#{}`,
  },
  {
    prefix: 'annotate',
    detail: 'label a point on a curve',
    template: `annotate {
    on_curve = #{R_TRF_INC}:#{51};
    at_I     = #{18430 A};
    label    = "#{I_kmax 18.43 kA}";
    style    = "leader";
}#{}`,
  },
];

/** The snippets as CodeMirror completions, ready to concatenate. */
export const snippetCompletions: Completion[] = SNIPPETS.map((s) =>
  snippetCompletion(s.template, {
    label: s.prefix,
    detail: s.detail,
    type: 'snippet',
    boost: -10, // rank below exact keyword/field matches
  }),
);

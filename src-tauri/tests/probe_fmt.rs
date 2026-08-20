use sqlformat::{format, Dialect, FormatOptions, Indent, QueryParams};

fn f(sql: &str, width: usize) -> String {
    format(
        sql,
        &QueryParams::None,
        &FormatOptions {
            indent: Indent::Spaces(2),
            uppercase: None,
            lines_between_queries: 1,
            dialect: Dialect::PostgreSql,
            max_inline_top_level: Some(width),
            max_inline_arguments: Some(width),
            max_inline_block: width,
            joins_as_top_level: std::env::var("JOINS").is_ok(),
            ..Default::default()
        },
    )
}

#[test]
fn probe() {
    let cases = [
        "select id, email, plan, created_at, updated_at, last_seen_at, trial_ends_at, referrer, utm_source, utm_medium, utm_campaign, billing_country, seat_count from users where plan = 'free' and created_at > '2026-01-01' and seat_count > 3 and billing_country in ('FR','DE','ES')",
        "select id, email, plan, created_at, updated_at, last_seen_at, trial_ends_at, referrer from users where plan = 'free'",
        "select * from a join b on a.id = b.a_id join c on c.id = b.c_id join d on d.id = c.d_id where a.x = 1",
        "select * from orders where status = 'paid' limit 5",
        "select a.id, a.email, a.plan, count(*) as n from orders o join customers a on a.id = o.customer_id where o.status = 'paid' and o.created_at > now() - interval '30 days' group by a.id, a.email, a.plan having count(*) > 2 order by n desc limit 20",
        "update users set email = 'x@y.z', plan = 'pro' where id = 1",
        "insert into t (a, b, c) values (1, 2, 3)",
    ];
    for width in [80usize] {
        for sql in cases {
            println!("=== width {width}\n{}\n", f(sql, width));
        }
    }
}

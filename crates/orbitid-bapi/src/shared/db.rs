use orbitid_core::error::Result;
use sqlx::postgres::PgRow;
use sqlx::{FromRow, PgPool};

pub use orbitid_identity::admin::{
    get_user_or_throw, normalize_email, refuse_user_credential_mutation, ticket_url,
};

/// One bound parameter of a dynamic filter.

#[derive(Debug, Clone)]
pub enum Bind {
    Text(String),
    Int(i64),
    Bool(bool),
    TextList(Vec<String>),
}

/// A WHERE fragment plus its bound parameters, assembled with numbered
/// placeholders so the same filter can select rows and count them.
#[derive(Debug, Default, Clone)]
pub struct Where {
    pub clauses: Vec<String>,
    pub binds: Vec<Bind>,
}

impl Where {
    pub fn new() -> Self {
        Self::default()
    }

    fn push(&mut self, bind: Bind) -> String {
        self.binds.push(bind);
        format!("${}", self.binds.len())
    }

    /// Binds a text parameter and returns its placeholder (for custom clauses).
    pub fn bind_text(&mut self, value: String) -> String {
        self.push(Bind::Text(value))
    }

    /// `column = value`
    pub fn equal_text(&mut self, column: &str, value: &str) {
        let slot = self.push(Bind::Text(value.to_string()));
        self.clauses.push(format!("{column} = {slot}"));
    }

    /// `column = ANY(values)`
    pub fn one_of_text(&mut self, column: &str, values: &[String]) {
        if values.is_empty() {
            self.clauses.push("1 = 0".to_string());
            return;
        }
        let slot = self.push(Bind::TextList(values.to_vec()));
        self.clauses.push(format!("{column} = ANY({slot})"));
    }

    /// `column = value` for integers.
    pub fn at_least(&mut self, column: &str, value: i64) {
        let slot = self.push(Bind::Int(value));
        self.clauses.push(format!("{column} >= {slot}"));
    }

    /// `column > value` for integers.
    pub fn after(&mut self, column: &str, value: i64) {
        let slot = self.push(Bind::Int(value));
        self.clauses.push(format!("{column} > {slot}"));
    }

    /// `column < value` for integers.
    pub fn before(&mut self, column: &str, value: i64) {
        let slot = self.push(Bind::Int(value));
        self.clauses.push(format!("{column} < {slot}"));
    }

    /// `column = value` for booleans.
    pub fn equal_bool(&mut self, column: &str, value: bool) {
        let slot = self.push(Bind::Bool(value));
        self.clauses.push(format!("{column} = {slot}"));
    }

    /// A raw clause with its own `$n` placeholders, plus the matching binds.
    pub fn raw(&mut self, clause: impl Into<String>) {
        self.clauses.push(clause.into());
    }

    /// A raw clause plus binds whose placeholders start at the next index.
    pub fn raw_bound(&mut self, build: impl FnOnce(&mut Self) -> String) {
        let clause = build(self);
        self.clauses.push(clause);
    }

    /// `WHERE ...` (or an empty string).
    pub fn sql(&self) -> String {
        if self.clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", self.clauses.join(" AND "))
        }
    }
}

fn bind_query<'q, T>(
    mut query: sqlx::query::QueryAs<'q, sqlx::Postgres, T, sqlx::postgres::PgArguments>,
    binds: &'q [Bind],
) -> sqlx::query::QueryAs<'q, sqlx::Postgres, T, sqlx::postgres::PgArguments>
where
    T: for<'r> FromRow<'r, PgRow> + Send + Unpin,
{
    for bind in binds {
        query = match bind {
            Bind::Text(value) => query.bind(value.clone()),
            Bind::Int(value) => query.bind(*value),
            Bind::Bool(value) => query.bind(*value),
            Bind::TextList(values) => query.bind(values.clone()),
        };
    }
    query
}

/// Runs a `SELECT` with the given binds.
pub async fn fetch_all<T>(pool: &PgPool, sql: &str, binds: &[Bind]) -> Result<Vec<T>>
where
    T: for<'r> FromRow<'r, PgRow> + Send + Unpin,
{
    Ok(bind_query(sqlx::query_as::<_, T>(sql), binds)
        .fetch_all(pool)
        .await?)
}

/// Runs `SELECT count(*) ...` with the given binds.
pub async fn fetch_count(pool: &PgPool, sql: &str, binds: &[Bind]) -> Result<i64> {
    let mut query = sqlx::query_scalar::<_, i64>(sql);
    for bind in binds {
        query = match bind {
            Bind::Text(value) => query.bind(value.clone()),
            Bind::Int(value) => query.bind(*value),
            Bind::Bool(value) => query.bind(*value),
            Bind::TextList(values) => query.bind(values.clone()),
        };
    }
    Ok(query.fetch_one(pool).await?)
}

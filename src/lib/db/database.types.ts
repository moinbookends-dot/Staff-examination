/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Produced by `npm run gen:types` (scripts/gen-types.mjs) from the live
 * schema. Hand edits are lost on regeneration, and CI fails on any drift
 * between this file and the database.
 *
 * Regenerate after every migration.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      "attempt_answers": {
        Row: {
          "attempt_id": string
          "question_id": string
          "question_revision": number
          "answer": Json
          "auto_grade_status": Database["public"]["Enums"]["auto_grade_status"]
          "score": number | null
          "needs_review": boolean
          "grader_note": string | null
          "answered_at": string
          "updated_at": string
        }
        Insert: {
          "attempt_id": string
          "question_id": string
          "question_revision": number
          "answer": Json
          "auto_grade_status"?: Database["public"]["Enums"]["auto_grade_status"]
          "score"?: number | null
          "needs_review"?: boolean
          "grader_note"?: string | null
          "answered_at"?: string
          "updated_at"?: string
        }
        Update: {
          "attempt_id"?: string
          "question_id"?: string
          "question_revision"?: number
          "answer"?: Json
          "auto_grade_status"?: Database["public"]["Enums"]["auto_grade_status"]
          "score"?: number | null
          "needs_review"?: boolean
          "grader_note"?: string | null
          "answered_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "attempt_questions": {
        Row: {
          "attempt_id": string
          "section_id": string | null
          "question_id": string
          "question_revision": number
          "snapshot": Json
          "content_version": number
          "position": number
          "marks": number
          "negative_marks": number
          "fallback_reason": string | null
          "created_at": string
        }
        Insert: {
          "attempt_id": string
          "section_id"?: string | null
          "question_id": string
          "question_revision": number
          "snapshot": Json
          "content_version"?: number
          "position": number
          "marks": number
          "negative_marks"?: number
          "fallback_reason"?: string | null
          "created_at"?: string
        }
        Update: {
          "attempt_id"?: string
          "section_id"?: string | null
          "question_id"?: string
          "question_revision"?: number
          "snapshot"?: Json
          "content_version"?: number
          "position"?: number
          "marks"?: number
          "negative_marks"?: number
          "fallback_reason"?: string | null
          "created_at"?: string
        }
        Relationships: []
      }
      "attempts": {
        Row: {
          "id": string
          "exam_id": string
          "candidate_id": string
          "company_id": string
          "status": Database["public"]["Enums"]["attempt_status"]
          "attempt_number": number
          "started_at": string
          "expires_at": string
          "submitted_at": string | null
          "submit_reason": Database["public"]["Enums"]["submit_reason"] | null
          "score": number | null
          "max_score": number | null
          "passed": boolean | null
          "auto_graded_at": string | null
          "requires_manual_grading": boolean
          "violation_count": number
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "exam_id": string
          "candidate_id": string
          "company_id": string
          "status"?: Database["public"]["Enums"]["attempt_status"]
          "attempt_number": number
          "started_at"?: string
          "expires_at": string
          "submitted_at"?: string | null
          "submit_reason"?: Database["public"]["Enums"]["submit_reason"] | null
          "score"?: number | null
          "max_score"?: number | null
          "passed"?: boolean | null
          "auto_graded_at"?: string | null
          "requires_manual_grading"?: boolean
          "violation_count"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "exam_id"?: string
          "candidate_id"?: string
          "company_id"?: string
          "status"?: Database["public"]["Enums"]["attempt_status"]
          "attempt_number"?: number
          "started_at"?: string
          "expires_at"?: string
          "submitted_at"?: string | null
          "submit_reason"?: Database["public"]["Enums"]["submit_reason"] | null
          "score"?: number | null
          "max_score"?: number | null
          "passed"?: boolean | null
          "auto_graded_at"?: string | null
          "requires_manual_grading"?: boolean
          "violation_count"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "audit_logs": {
        Row: {
          "id": number
          "occurred_at": string
          "actor_id": string | null
          "actor_email": string | null
          "actor_roles": string[] | null
          "action": string
          "table_name": string
          "record_id": string | null
          "changes": Json | null
          "context": Json | null
          "company_id": string | null
        }
        Insert: {
          "id"?: number
          "occurred_at"?: string
          "actor_id"?: string | null
          "actor_email"?: string | null
          "actor_roles"?: string[] | null
          "action": string
          "table_name": string
          "record_id"?: string | null
          "changes"?: Json | null
          "context"?: Json | null
          "company_id"?: string | null
        }
        Update: {
          "id"?: number
          "occurred_at"?: string
          "actor_id"?: string | null
          "actor_email"?: string | null
          "actor_roles"?: string[] | null
          "action"?: string
          "table_name"?: string
          "record_id"?: string | null
          "changes"?: Json | null
          "context"?: Json | null
          "company_id"?: string | null
        }
        Relationships: []
      }
      "brands": {
        Row: {
          "id": string
          "company_id": string
          "name": string
          "slug": string
          "cuisine": string | null
          "logo_path": string | null
          "deleted_at": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "company_id": string
          "name": string
          "slug": string
          "cuisine"?: string | null
          "logo_path"?: string | null
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "company_id"?: string
          "name"?: string
          "slug"?: string
          "cuisine"?: string | null
          "logo_path"?: string | null
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "categories": {
        Row: {
          "id": string
          "company_id": string
          "parent_id": string | null
          "name": string
          "slug": string
          "description": string | null
          "sort_order": number
          "deleted_at": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "company_id": string
          "parent_id"?: string | null
          "name": string
          "slug": string
          "description"?: string | null
          "sort_order"?: number
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "company_id"?: string
          "parent_id"?: string | null
          "name"?: string
          "slug"?: string
          "description"?: string | null
          "sort_order"?: number
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "companies": {
        Row: {
          "id": string
          "name": string
          "slug": string
          "logo_path": string | null
          "settings": Json
          "deleted_at": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "name": string
          "slug": string
          "logo_path"?: string | null
          "settings"?: Json
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "name"?: string
          "slug"?: string
          "logo_path"?: string | null
          "settings"?: Json
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "departments": {
        Row: {
          "id": string
          "company_id": string
          "name": string
          "slug": string
          "description": string | null
          "sort_order": number
          "deleted_at": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "company_id": string
          "name": string
          "slug": string
          "description"?: string | null
          "sort_order"?: number
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "company_id"?: string
          "name"?: string
          "slug"?: string
          "description"?: string | null
          "sort_order"?: number
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "email_outbox": {
        Row: {
          "id": string
          "to_email": string
          "to_user_id": string | null
          "subject": string
          "template": string
          "payload": Json
          "priority": number
          "scheduled_for": string
          "sent_at": string | null
          "failed_at": string | null
          "attempts": number
          "last_error": string | null
          "created_at": string
        }
        Insert: {
          "id"?: string
          "to_email": string
          "to_user_id"?: string | null
          "subject": string
          "template": string
          "payload"?: Json
          "priority"?: number
          "scheduled_for"?: string
          "sent_at"?: string | null
          "failed_at"?: string | null
          "attempts"?: number
          "last_error"?: string | null
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "to_email"?: string
          "to_user_id"?: string | null
          "subject"?: string
          "template"?: string
          "payload"?: Json
          "priority"?: number
          "scheduled_for"?: string
          "sent_at"?: string | null
          "failed_at"?: string | null
          "attempts"?: number
          "last_error"?: string | null
          "created_at"?: string
        }
        Relationships: []
      }
      "exam_assignments": {
        Row: {
          "id": string
          "exam_id": string
          "target_kind": Database["public"]["Enums"]["assignment_target"]
          "target_id": string | null
          "target_role": string | null
          "assigned_by": string | null
          "assigned_at": string
          "target_user_id": string | null
        }
        Insert: {
          "id"?: string
          "exam_id": string
          "target_kind": Database["public"]["Enums"]["assignment_target"]
          "target_id"?: string | null
          "target_role"?: string | null
          "assigned_by"?: string | null
          "assigned_at"?: string
          "target_user_id"?: string | null
        }
        Update: {
          "id"?: string
          "exam_id"?: string
          "target_kind"?: Database["public"]["Enums"]["assignment_target"]
          "target_id"?: string | null
          "target_role"?: string | null
          "assigned_by"?: string | null
          "assigned_at"?: string
          "target_user_id"?: string | null
        }
        Relationships: []
      }
      "exam_questions": {
        Row: {
          "exam_id": string
          "section_id": string
          "rule_id": string | null
          "question_id": string
          "question_revision": number
          "snapshot": Json
          "content_version": number
          "position": number
          "marks": number
          "negative_marks": number
          "fallback_reason": string | null
          "created_at": string
        }
        Insert: {
          "exam_id": string
          "section_id": string
          "rule_id"?: string | null
          "question_id": string
          "question_revision": number
          "snapshot": Json
          "content_version"?: number
          "position": number
          "marks": number
          "negative_marks"?: number
          "fallback_reason"?: string | null
          "created_at"?: string
        }
        Update: {
          "exam_id"?: string
          "section_id"?: string
          "rule_id"?: string | null
          "question_id"?: string
          "question_revision"?: number
          "snapshot"?: Json
          "content_version"?: number
          "position"?: number
          "marks"?: number
          "negative_marks"?: number
          "fallback_reason"?: string | null
          "created_at"?: string
        }
        Relationships: []
      }
      "exam_rules": {
        Row: {
          "id": string
          "section_id": string
          "sort_order": number
          "category_id": string | null
          "include_subcategories": boolean
          "tag_ids": string[]
          "question_types": Database["public"]["Enums"]["question_type"][] | null
          "difficulty_min": number
          "difficulty_max": number
          "question_count": number
          "marks_per_question": number | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "section_id": string
          "sort_order"?: number
          "category_id"?: string | null
          "include_subcategories"?: boolean
          "tag_ids"?: string[]
          "question_types"?: Database["public"]["Enums"]["question_type"][] | null
          "difficulty_min"?: number
          "difficulty_max"?: number
          "question_count": number
          "marks_per_question"?: number | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "section_id"?: string
          "sort_order"?: number
          "category_id"?: string | null
          "include_subcategories"?: boolean
          "tag_ids"?: string[]
          "question_types"?: Database["public"]["Enums"]["question_type"][] | null
          "difficulty_min"?: number
          "difficulty_max"?: number
          "question_count"?: number
          "marks_per_question"?: number | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "exam_sections": {
        Row: {
          "id": string
          "exam_id": string
          "title": string
          "description": string | null
          "instructions": string | null
          "sort_order": number
          "duration_minutes": number | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "exam_id": string
          "title": string
          "description"?: string | null
          "instructions"?: string | null
          "sort_order"?: number
          "duration_minutes"?: number | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "exam_id"?: string
          "title"?: string
          "description"?: string | null
          "instructions"?: string | null
          "sort_order"?: number
          "duration_minutes"?: number | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "exams": {
        Row: {
          "id": string
          "company_id": string
          "brand_id": string | null
          "title": string
          "description": string | null
          "instructions": string | null
          "kind": Database["public"]["Enums"]["exam_kind"]
          "status": Database["public"]["Enums"]["exam_status"]
          "paper_mode": Database["public"]["Enums"]["paper_mode"]
          "duration_minutes": number
          "opens_at": string | null
          "closes_at": string | null
          "timezone": string
          "max_attempts": number
          "pass_mark_percent": number
          "shuffle_questions": boolean
          "shuffle_options": boolean
          "allow_backtrack": boolean
          "negative_marking_enabled": boolean
          "verification_mode": Database["public"]["Enums"]["verification_mode"]
          "requires_manual_grading": boolean
          "counts_towards_analytics": boolean
          "total_marks": number | null
          "question_count": number | null
          "created_by": string
          "updated_by": string | null
          "published_by": string | null
          "published_at": string | null
          "deleted_at": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "company_id": string
          "brand_id"?: string | null
          "title": string
          "description"?: string | null
          "instructions"?: string | null
          "kind"?: Database["public"]["Enums"]["exam_kind"]
          "status"?: Database["public"]["Enums"]["exam_status"]
          "paper_mode"?: Database["public"]["Enums"]["paper_mode"]
          "duration_minutes"?: number
          "opens_at"?: string | null
          "closes_at"?: string | null
          "timezone"?: string
          "max_attempts"?: number
          "pass_mark_percent"?: number
          "shuffle_questions"?: boolean
          "shuffle_options"?: boolean
          "allow_backtrack"?: boolean
          "negative_marking_enabled"?: boolean
          "verification_mode"?: Database["public"]["Enums"]["verification_mode"]
          "requires_manual_grading"?: boolean
          "counts_towards_analytics"?: boolean
          "total_marks"?: number | null
          "question_count"?: number | null
          "created_by": string
          "updated_by"?: string | null
          "published_by"?: string | null
          "published_at"?: string | null
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "company_id"?: string
          "brand_id"?: string | null
          "title"?: string
          "description"?: string | null
          "instructions"?: string | null
          "kind"?: Database["public"]["Enums"]["exam_kind"]
          "status"?: Database["public"]["Enums"]["exam_status"]
          "paper_mode"?: Database["public"]["Enums"]["paper_mode"]
          "duration_minutes"?: number
          "opens_at"?: string | null
          "closes_at"?: string | null
          "timezone"?: string
          "max_attempts"?: number
          "pass_mark_percent"?: number
          "shuffle_questions"?: boolean
          "shuffle_options"?: boolean
          "allow_backtrack"?: boolean
          "negative_marking_enabled"?: boolean
          "verification_mode"?: Database["public"]["Enums"]["verification_mode"]
          "requires_manual_grading"?: boolean
          "counts_towards_analytics"?: boolean
          "total_marks"?: number | null
          "question_count"?: number | null
          "created_by"?: string
          "updated_by"?: string | null
          "published_by"?: string | null
          "published_at"?: string | null
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "notifications": {
        Row: {
          "id": string
          "user_id": string
          "kind": string
          "title": string
          "body": string | null
          "link": string | null
          "data": Json
          "read_at": string | null
          "created_at": string
        }
        Insert: {
          "id"?: string
          "user_id": string
          "kind": string
          "title": string
          "body"?: string | null
          "link"?: string | null
          "data"?: Json
          "read_at"?: string | null
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "user_id"?: string
          "kind"?: string
          "title"?: string
          "body"?: string | null
          "link"?: string | null
          "data"?: Json
          "read_at"?: string | null
          "created_at"?: string
        }
        Relationships: []
      }
      "outlets": {
        Row: {
          "id": string
          "company_id": string
          "brand_id": string
          "name": string
          "code": string
          "city": string | null
          "state": string | null
          "address": string | null
          "timezone": string
          "is_active": boolean
          "deleted_at": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "company_id": string
          "brand_id": string
          "name": string
          "code": string
          "city"?: string | null
          "state"?: string | null
          "address"?: string | null
          "timezone"?: string
          "is_active"?: boolean
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "company_id"?: string
          "brand_id"?: string
          "name"?: string
          "code"?: string
          "city"?: string | null
          "state"?: string | null
          "address"?: string | null
          "timezone"?: string
          "is_active"?: boolean
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "permissions": {
        Row: {
          "id": string
          "key": string
          "module": string
          "action": string
          "description": string | null
          "created_at": string
        }
        Insert: {
          "id"?: string
          "key": string
          "module": string
          "action": string
          "description"?: string | null
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "key"?: string
          "module"?: string
          "action"?: string
          "description"?: string | null
          "created_at"?: string
        }
        Relationships: []
      }
      "profiles": {
        Row: {
          "id": string
          "company_id": string | null
          "email": string
          "full_name": string
          "phone": string | null
          "employee_code": string | null
          "brand_id": string | null
          "outlet_id": string | null
          "department_id": string | null
          "preferred_locale": string
          "approval_status": Database["public"]["Enums"]["approval_status"]
          "approved_by": string | null
          "approved_at": string | null
          "rejection_reason": string | null
          "experience_level": number | null
          "joined_at": string | null
          "avatar_path": string | null
          "email_opt_in": boolean
          "deleted_at": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id": string
          "company_id"?: string | null
          "email": string
          "full_name": string
          "phone"?: string | null
          "employee_code"?: string | null
          "brand_id"?: string | null
          "outlet_id"?: string | null
          "department_id"?: string | null
          "preferred_locale"?: string
          "approval_status"?: Database["public"]["Enums"]["approval_status"]
          "approved_by"?: string | null
          "approved_at"?: string | null
          "rejection_reason"?: string | null
          "experience_level"?: number | null
          "joined_at"?: string | null
          "avatar_path"?: string | null
          "email_opt_in"?: boolean
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "company_id"?: string | null
          "email"?: string
          "full_name"?: string
          "phone"?: string | null
          "employee_code"?: string | null
          "brand_id"?: string | null
          "outlet_id"?: string | null
          "department_id"?: string | null
          "preferred_locale"?: string
          "approval_status"?: Database["public"]["Enums"]["approval_status"]
          "approved_by"?: string | null
          "approved_at"?: string | null
          "rejection_reason"?: string | null
          "experience_level"?: number | null
          "joined_at"?: string | null
          "avatar_path"?: string | null
          "email_opt_in"?: boolean
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "question_answer_keys": {
        Row: {
          "question_id": string
          "answer_key": Json
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "question_id": string
          "answer_key": Json
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "question_id"?: string
          "answer_key"?: Json
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "question_media": {
        Row: {
          "id": string
          "question_id": string
          "kind": string
          "provider": string
          "storage_path": string | null
          "external_url": string | null
          "mime_type": string | null
          "bytes": number | null
          "width": number | null
          "height": number | null
          "duration_seconds": number | null
          "alt_text": string | null
          "sort_order": number
          "created_at": string
        }
        Insert: {
          "id"?: string
          "question_id": string
          "kind": string
          "provider"?: string
          "storage_path"?: string | null
          "external_url"?: string | null
          "mime_type"?: string | null
          "bytes"?: number | null
          "width"?: number | null
          "height"?: number | null
          "duration_seconds"?: number | null
          "alt_text"?: string | null
          "sort_order"?: number
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "question_id"?: string
          "kind"?: string
          "provider"?: string
          "storage_path"?: string | null
          "external_url"?: string | null
          "mime_type"?: string | null
          "bytes"?: number | null
          "width"?: number | null
          "height"?: number | null
          "duration_seconds"?: number | null
          "alt_text"?: string | null
          "sort_order"?: number
          "created_at"?: string
        }
        Relationships: []
      }
      "question_revisions": {
        Row: {
          "question_id": string
          "revision": number
          "stem": string
          "content": Json
          "answer_key": Json | null
          "response_format": Database["public"]["Enums"]["response_format"]
          "question_type": Database["public"]["Enums"]["question_type"]
          "marks": number
          "negative_marks": number
          "content_version": number
          "edited_by": string | null
          "edited_at": string
          "change_note": string | null
        }
        Insert: {
          "question_id": string
          "revision": number
          "stem": string
          "content": Json
          "answer_key"?: Json | null
          "response_format": Database["public"]["Enums"]["response_format"]
          "question_type": Database["public"]["Enums"]["question_type"]
          "marks": number
          "negative_marks": number
          "content_version"?: number
          "edited_by"?: string | null
          "edited_at"?: string
          "change_note"?: string | null
        }
        Update: {
          "question_id"?: string
          "revision"?: number
          "stem"?: string
          "content"?: Json
          "answer_key"?: Json | null
          "response_format"?: Database["public"]["Enums"]["response_format"]
          "question_type"?: Database["public"]["Enums"]["question_type"]
          "marks"?: number
          "negative_marks"?: number
          "content_version"?: number
          "edited_by"?: string | null
          "edited_at"?: string
          "change_note"?: string | null
        }
        Relationships: []
      }
      "question_tags": {
        Row: {
          "question_id": string
          "tag_id": string
        }
        Insert: {
          "question_id": string
          "tag_id": string
        }
        Update: {
          "question_id"?: string
          "tag_id"?: string
        }
        Relationships: []
      }
      "question_translations": {
        Row: {
          "question_id": string
          "locale": string
          "stem": string
          "content": Json
          "explanation": string | null
          "status": string
          "source": string
          "translated_by": string | null
          "reviewed_by": string | null
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "question_id": string
          "locale": string
          "stem": string
          "content"?: Json
          "explanation"?: string | null
          "status"?: string
          "source"?: string
          "translated_by"?: string | null
          "reviewed_by"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "question_id"?: string
          "locale"?: string
          "stem"?: string
          "content"?: Json
          "explanation"?: string | null
          "status"?: string
          "source"?: string
          "translated_by"?: string | null
          "reviewed_by"?: string | null
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "questions": {
        Row: {
          "id": string
          "company_id": string
          "brand_id": string | null
          "type": Database["public"]["Enums"]["question_type"]
          "response_format": Database["public"]["Enums"]["response_format"]
          "content_version": number
          "stem": string
          "content": Json
          "category_id": string | null
          "difficulty": number
          "marks": number
          "negative_marks": number
          "estimated_seconds": number | null
          "explanation": string | null
          "reference_note": string | null
          "status": Database["public"]["Enums"]["question_status"]
          "source": string
          "usage_count": number
          "created_by": string
          "updated_by": string | null
          "deleted_at": string | null
          "created_at": string
          "updated_at": string
          "search_tsv": string | null
          "revision": number
        }
        Insert: {
          "id"?: string
          "company_id": string
          "brand_id"?: string | null
          "type": Database["public"]["Enums"]["question_type"]
          "response_format": Database["public"]["Enums"]["response_format"]
          "content_version"?: number
          "stem": string
          "content"?: Json
          "category_id"?: string | null
          "difficulty"?: number
          "marks"?: number
          "negative_marks"?: number
          "estimated_seconds"?: number | null
          "explanation"?: string | null
          "reference_note"?: string | null
          "status"?: Database["public"]["Enums"]["question_status"]
          "source"?: string
          "usage_count"?: number
          "created_by": string
          "updated_by"?: string | null
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
          "revision"?: number
        }
        Update: {
          "id"?: string
          "company_id"?: string
          "brand_id"?: string | null
          "type"?: Database["public"]["Enums"]["question_type"]
          "response_format"?: Database["public"]["Enums"]["response_format"]
          "content_version"?: number
          "stem"?: string
          "content"?: Json
          "category_id"?: string | null
          "difficulty"?: number
          "marks"?: number
          "negative_marks"?: number
          "estimated_seconds"?: number | null
          "explanation"?: string | null
          "reference_note"?: string | null
          "status"?: Database["public"]["Enums"]["question_status"]
          "source"?: string
          "usage_count"?: number
          "created_by"?: string
          "updated_by"?: string | null
          "deleted_at"?: string | null
          "created_at"?: string
          "updated_at"?: string
          "revision"?: number
        }
        Relationships: []
      }
      "role_permissions": {
        Row: {
          "role_id": string
          "permission_id": string
          "created_at": string
        }
        Insert: {
          "role_id": string
          "permission_id": string
          "created_at"?: string
        }
        Update: {
          "role_id"?: string
          "permission_id"?: string
          "created_at"?: string
        }
        Relationships: []
      }
      "roles": {
        Row: {
          "id": string
          "company_id": string | null
          "key": string
          "name": string
          "description": string | null
          "is_system": boolean
          "sort_order": number
          "created_at": string
          "updated_at": string
        }
        Insert: {
          "id"?: string
          "company_id"?: string | null
          "key": string
          "name": string
          "description"?: string | null
          "is_system"?: boolean
          "sort_order"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Update: {
          "id"?: string
          "company_id"?: string | null
          "key"?: string
          "name"?: string
          "description"?: string | null
          "is_system"?: boolean
          "sort_order"?: number
          "created_at"?: string
          "updated_at"?: string
        }
        Relationships: []
      }
      "tags": {
        Row: {
          "id": string
          "company_id": string
          "name": string
          "slug": string
          "created_at": string
        }
        Insert: {
          "id"?: string
          "company_id": string
          "name": string
          "slug": string
          "created_at"?: string
        }
        Update: {
          "id"?: string
          "company_id"?: string
          "name"?: string
          "slug"?: string
          "created_at"?: string
        }
        Relationships: []
      }
      "user_roles": {
        Row: {
          "user_id": string
          "role_id": string
          "granted_by": string | null
          "granted_at": string
        }
        Insert: {
          "user_id": string
          "role_id": string
          "granted_by"?: string | null
          "granted_at"?: string
        }
        Update: {
          "user_id"?: string
          "role_id"?: string
          "granted_by"?: string | null
          "granted_at"?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      "answer_key_at_revision": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "assignment_matches": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "attempt_paper": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "audit_row": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "bump_question_revision": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "bump_revision_from_answer_key": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "capture_answer_key_revision": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "capture_question_revision": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "custom_access_token_hook": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "draw_paper": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "duplicate_exam": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "enforce_exam_child_immutability": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "enforce_exam_immutability": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "exam_audience": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "exam_health": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "exam_paper": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "exam_rule_counts": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "exam_status_transition_allowed": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "get_question_revision": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "handle_new_user": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "has_perm": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "has_role": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "is_approved": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "is_exam_assigned_to_me": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "is_super_admin": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "jwt_app": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "me_status": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "my_brand": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "my_company": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "my_department": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "my_outlet": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "preview_rule_count": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "profile_brand": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "publish_exam": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "question_pool": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "question_snapshot": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "save_question": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "set_updated_at": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "start_attempt": {
        Args: Record<string, unknown>
        Returns: unknown
      }
      "validate_question_content": {
        Args: Record<string, unknown>
        Returns: unknown
      }
    }
    Enums: {
      "approval_status": "pending" | "approved" | "rejected" | "suspended"
      "assignment_target": "outlet" | "department" | "brand" | "role" | "user"
      "attempt_status": "in_progress" | "submitted" | "auto_graded" | "evaluating" | "evaluated" | "verifying" | "verified" | "returned" | "published" | "expired" | "voided"
      "auto_grade_status": "not_applicable" | "pending" | "graded" | "needs_review"
      "exam_kind": "official" | "practice" | "quiz" | "monthly" | "annual" | "practical"
      "exam_status": "draft" | "scheduled" | "active" | "completed" | "archived" | "cancelled"
      "paper_mode": "fixed" | "per_attempt"
      "question_status": "draft" | "active" | "retired"
      "question_type": "mcq_single" | "mcq_multi" | "true_false" | "fill_blank" | "match" | "sequence" | "short_answer" | "essay" | "image" | "video" | "audio" | "document" | "practical" | "viva"
      "response_format": "choice_single" | "choice_multi" | "boolean" | "blanks" | "pairs" | "order" | "text_short" | "text_long" | "evaluator_only"
      "submit_reason": "user" | "timer" | "tab_switch" | "sweeper" | "admin"
      "verification_mode": "auto" | "single" | "dual"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"]
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"]
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T]

import { Link, Navigate } from "react-router-dom";
import { IconArrowRight } from "@tabler/icons-react";
import { SectionLayout } from "../../layout/SectionLayout";
import { useContentTypes } from "../../hooks/queries";
import { EmptyHero, EntryListArt } from "../../components/common/EmptyHero";
import { TypeNav } from "./TypeNav";

export function ContentIndexPage() {
  const { data: types, isLoading } = useContentTypes();
  if (!isLoading && types && types.length > 0) {
    return <Navigate to={`/content/${types[0]!.uid}`} replace />;
  }
  return (
    <SectionLayout panelTitle="Content Manager" panel={<TypeNav />}>
      <div className="page-head">
        <h1>Content Manager</h1>
      </div>
      {!isLoading && (
        <EmptyHero
          art={<EntryListArt />}
          title="Nothing to manage yet"
          copy="Entries live here once a content type exists — define your first type in the Content-type Builder, then come back to create and publish entries."
          actions={
            <Link to="/ctb" className="btn btn-primary">
              Open Content-type Builder <IconArrowRight size="1.5rem" />
            </Link>
          }
        />
      )}
    </SectionLayout>
  );
}
